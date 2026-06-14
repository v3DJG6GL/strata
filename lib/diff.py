"""Compare two snapshots into a delta tree, summary and change list.

Operates on the pre-aggregated `strata-<ts>.tree.json` artifacts produced by
aggregate.py. Real directories are matched by absolute path; the synthetic
"(other)" buckets are paired positionally under their shared parent.

Two notions of change are tracked per directory:
  * subtree delta  -- cur minus base over the whole subtree (drives colours)
  * self delta     -- the subtree delta minus the deltas of all children, i.e.
                      the change attributable to this directory itself. Ranking
                      "top growers" by self delta stops one deep change from
                      being counted again at every ancestor.
An added/removed directory is reported as a single event at the top of its
subtree rather than once per descendant.
"""

import json

# Size deltas with magnitude at or below this count as "unchanged" (sizes
# wobble by a filesystem block between otherwise-identical scans).
EPS = 4096


def _delta(cur, base, key):
    return ((cur or {}).get(key) or 0) - ((base or {}).get(key) or 0)


def _classify(d_actual):
    if d_actual > EPS:
        return "grew"
    if d_actual < -EPS:
        return "shrank"
    return "unchanged"


def _split_children(node):
    """Return ({path: real_child}, other_bucket_or_None) for a tree node."""
    reals, other = {}, None
    for c in (node or {}).get("children", []):
        if c.get("other"):
            other = c
        else:
            reals[c.get("path")] = c
    return reals, other


def _diff_node(cur, base):
    """Build one delta-tree node (its children are filled in by _build)."""
    if cur is not None and base is not None:
        status = _classify(_delta(cur, base, "size_actual"))
    elif cur is not None:
        status = "added"
    else:
        status = "removed"

    # Removed directories lay out (as ghosts) using their last-known base size.
    src = cur if cur is not None else base
    node = {
        "name": src.get("name"),
        "path": src.get("path"),
        "status": status,
        "truncated": bool((cur or {}).get("truncated") or (base or {}).get("truncated")),
        "size_actual": src.get("size_actual") or 0,
        "size_apparent": src.get("size_apparent") or 0,
        "count": src.get("count") or 0,
        "base_actual": (base or {}).get("size_actual") or 0,
        "base_apparent": (base or {}).get("size_apparent") or 0,
        "base_count": (base or {}).get("count") or 0,
        "d_actual": _delta(cur, base, "size_actual"),
        "d_apparent": _delta(cur, base, "size_apparent"),
        "d_count": _delta(cur, base, "count"),
        "children": [],
        # per-file diff: name-paired files for this directory (drives the file
        # slices in the compare sunburst and the file rows in the change table).
        "own_count": src.get("own_count") or 0,
        "files_top": _diff_files(cur, base),
    }
    return node


def _diff_files(cur, base):
    """Pair the two directories' files_top lists BY NAME into per-file deltas.
    Files have no identity across scans, so a rename/re-encode shows as one
    removed + one added -- acceptable for a directory-aggregating tool."""
    # A snapshot taken before per-file tracking carries no own_count/files_top.
    # own_count rides through _blank even when 0 (key-presence), so its ABSENCE
    # on an existing side is the reliable "this snapshot has no file data" signal
    # (an empty files_top, by contrast, legitimately means "tracked, no loose
    # files"). Diffing files against such a side would mark every counterpart
    # file spuriously added/removed, so skip the per-file diff for that pair.
    if (cur is not None and "own_count" not in cur) or (
        base is not None and "own_count" not in base
    ):
        return []
    base_files = {f.get("name"): f for f in (base or {}).get("files_top", [])}
    cur_names = {f.get("name") for f in (cur or {}).get("files_top", [])}
    out = []
    for cf in (cur or {}).get("files_top", []):          # added / changed / same
        out.append(_file_entry(cf.get("name"), cf, base_files.get(cf.get("name"))))
    for bf in (base or {}).get("files_top", []):         # base-only -> removed ghosts
        if bf.get("name") not in cur_names:
            out.append(_file_entry(bf.get("name"), None, bf))
    return out


def _file_entry(name, cf, bf):
    """One name-paired file: status + sizes + deltas. cf/bf = cur/base or None."""
    src = cf if cf is not None else bf
    if cf is not None and bf is not None:
        status = _classify((cf.get("size_actual") or 0) - (bf.get("size_actual") or 0))
    else:
        status = "added" if cf is not None else "removed"
    return {
        "name": name,
        "size_actual": src.get("size_actual") or 0,
        "size_apparent": src.get("size_apparent") or 0,
        "nlink": src.get("nlink"),
        "status": status,
        "base_actual": (bf or {}).get("size_actual") or 0,
        "base_apparent": (bf or {}).get("size_apparent") or 0,
        "d_actual": ((cf or {}).get("size_actual") or 0) - ((bf or {}).get("size_actual") or 0),
        "d_apparent": ((cf or {}).get("size_apparent") or 0) - ((bf or {}).get("size_apparent") or 0),
    }


def _build(cur, base):
    """Recursively build the delta subtree for one matched directory pair.

    Exactly one side may be None: base None -> added, cur None -> removed.
    """
    node = _diff_node(cur, base)

    cur_reals, cur_other = _split_children(cur)
    base_reals, base_other = _split_children(base)

    # matched + added directories, walked in the current scan's order
    for path, cc in cur_reals.items():
        node["children"].append(_build(cc, base_reals.get(path)))
    # removed directories: present in base, gone from cur (grafted as ghosts)
    for path, bc in base_reals.items():
        if path not in cur_reals:
            node["children"].append(_build(None, bc))

    # the "(other)" buckets are paired as a single aggregate slice
    if cur_other is not None or base_other is not None:
        bucket = _diff_node(cur_other, base_other)
        bucket["other"] = True
        node["children"].append(bucket)

    return node


def _collect(node, parent_status, changes, counts):
    """Post-order pass: compute self deltas, tally statuses, gather changes."""
    status = node["status"]
    is_real = bool(node.get("path")) and not node.get("other")
    if is_real:
        counts[status] = counts.get(status, 0) + 1

    for child in node["children"]:
        _collect(child, status, changes, counts)

    if not is_real:
        return

    if status in ("added", "removed"):
        # One event at the top of an added/removed subtree; descendants of an
        # added/removed directory are part of the same event, not separate.
        if parent_status not in ("added", "removed"):
            for m in ("actual", "apparent", "count"):
                node["self_" + m] = node["d_" + m]
            changes.append(_change(node))
    else:
        for m in ("actual", "apparent", "count"):
            # The synthetic "(other)" bucket never emits its own change row, so
            # its delta must roll up into this directory's self delta -- folding
            # it into child_sum instead would attribute the change to nobody and
            # silently drop dirs whose churn lives entirely in their (other) bucket.
            child_sum = sum(c["d_" + m] for c in node["children"] if not c.get("other"))
            node["self_" + m] = node["d_" + m] - child_sum
        if (
            abs(node["self_actual"]) > EPS
            or abs(node["self_apparent"]) > EPS
            or node["self_count"] != 0
        ):
            changes.append(_change(node))
        # Per-file change rows for this matched directory. Emitted even when the
        # directory itself is "unchanged" (a file added then removed nets flat).
        # Files inside an added/removed subtree are NOT listed individually --
        # that whole subtree is a single event (the branch above), so we only
        # reach here for matched dirs. counts[] stays directory-only.
        for fe in node.get("files_top", []):
            if fe["status"] != "unchanged":
                changes.append(_file_change(node, fe))


def _file_change(dir_node, fe):
    """A flat per-file change record, shaped to coexist with directory rows in
    the same `changes` list (the `kind` field discriminates)."""
    return {
        "kind": "file",
        "path": dir_node["path"].rstrip("/") + "/" + (fe["name"] or ""),
        "name": fe["name"],
        "status": fe["status"],
        "base_actual": fe["base_actual"],
        "cur_actual": fe["size_actual"] if fe["status"] != "removed" else 0,
        "d_actual": fe["d_actual"],
        "d_apparent": fe["d_apparent"],
        "d_count": 0,            # a file has no item count
        "self_actual": fe["d_actual"],   # a file has no children: self == subtree
        "self_apparent": fe["d_apparent"],
        "self_count": 0,
        "nlink": fe.get("nlink"),
    }


def _change(node):
    """The flat per-directory record consumed by the diff table."""
    return {
        "kind": "dir",
        "path": node["path"],
        "name": node["name"],
        "status": node["status"],
        "base_actual": node["base_actual"],
        "cur_actual": node["size_actual"] if node["status"] != "removed" else 0,
        "d_actual": node["d_actual"],
        "d_apparent": node["d_apparent"],
        "d_count": node["d_count"],
        "self_actual": node.get("self_actual", node["d_actual"]),
        "self_apparent": node.get("self_apparent", node["d_apparent"]),
        "self_count": node.get("self_count", node["d_count"]),
    }


def _totals(root):
    return {
        "size_actual": root.get("size_actual") or 0,
        "size_apparent": root.get("size_apparent") or 0,
        "count": root.get("count") or 0,
    }


def find_node(root, path):
    """Locate the node at absolute `path` within a detail tree, or None.

    "(other)" buckets inherit their parent's path (see aggregate.py); skip them
    explicitly so the lookup is invariant under children-iteration order.
    Iterative so a deeply-nested filesystem won't blow the recursion limit.
    Trailing slashes are normalised on both sides so a "/foo" query still matches
    a "/foo/" node (and vice-versa): the prefix descent already rstrips, so the
    equality tests must too or a trailing-slash node is missed.

    The single path-lookup for the codebase: the web layer (api.cgi) calls it for
    both the dashboard drill (op=tree) and the compare drill (op=compare), and
    _reconcile_boundary uses it to look a folded fold-boundary directory up in the
    full tree."""
    path = (path or "").rstrip("/")
    cur = root
    while True:
        if not cur.get("other") and (cur.get("path") or "").rstrip("/") == path:
            return cur
        nxt = None
        for c in cur.get("children", []):
            if c.get("other"):
                continue
            cp = (c.get("path") or "").rstrip("/")
            if cp == path or path.startswith(cp + "/"):
                nxt = c
                break
        if nxt is None:
            return None
        cur = nxt


def _boundary_candidates(node):
    """(any_added, any_removed) over the real nodes of a diff tree -- whether the
    diff has any added/removed directory that might be a fold-boundary crossing.
    Lets compare() skip loading a full tree when the corresponding side can't
    have a boundary case (e.g. a diff with no removals never touches cur_full)."""
    added = removed = False
    stack = [node]
    while stack:
        n = stack.pop()
        if n.get("path") and not n.get("other"):
            st = n.get("status")
            if st == "added":
                added = True
            elif st == "removed":
                removed = True
        stack.extend(n.get("children", []))
        if added and removed:
            break
    return added, removed


def _restate_added(node, bc):
    """An 'added' node that actually existed (folded below the floor) in base:
    pull its real base totals from the full tree, recompute the delta against the
    node's (cur) totals, and reclassify. Children are left as-is: _reconcile_boundary
    walks post-order, so any real added descendant has already been restated, and a
    folded cur "(other)" child renders neutral and drills truthfully. Per-file rows
    are cleared because the folded base side has no per-file list to diff against
    here -- the drill itemises them."""
    node["base_actual"] = bc.get("size_actual") or 0
    node["base_apparent"] = bc.get("size_apparent") or 0
    node["base_count"] = bc.get("count") or 0
    node["d_actual"] = (node.get("size_actual") or 0) - node["base_actual"]
    node["d_apparent"] = (node.get("size_apparent") or 0) - node["base_apparent"]
    node["d_count"] = (node.get("count") or 0) - node["base_count"]
    node["status"] = _classify(node["d_actual"])
    node["files_top"] = []


def _restate_removed(node, cc):
    """A 'removed' ghost that actually still exists (folded below the floor) in
    cur: pull its real cur totals from the full tree, recompute the delta against
    the node's (base) totals, and reclassify. The folder shrank across the floor
    rather than vanishing, so the base-side child ghosts are dropped (else they
    emit spurious 'removed' rows for items that may still exist) and the node is
    marked truncated so a drill re-diffs the real subtree."""
    node["size_actual"] = cc.get("size_actual") or 0
    node["size_apparent"] = cc.get("size_apparent") or 0
    node["count"] = cc.get("count") or 0
    node["d_actual"] = node["size_actual"] - (node.get("base_actual") or 0)
    node["d_apparent"] = node["size_apparent"] - (node.get("base_apparent") or 0)
    node["d_count"] = node["count"] - (node.get("base_count") or 0)
    node["status"] = _classify(node["d_actual"])
    node["children"] = []
    node["files_top"] = []
    node["truncated"] = True


def _reconcile_boundary(tree, base_full, cur_full):
    """Restate fold-boundary added/removed directories as their true delta.

    build_compare folds directories below a size fraction of their scan root into
    a synthetic "(other)" bucket. A directory that crosses that floor between two
    scans is real on one side but folded on the other, so _build -- which matches
    the folded trees by path -- finds no counterpart and reports the whole folder
    'added' or 'removed'. The detail tree usually still holds the counterpart, so
    look its own totals up there and restate this node's base/cur sizes, delta and
    status. The change table and arc colour then agree with the full-tree drill-in
    (op=compare&path), which diffs the real subtree. A node with no counterpart in
    the detail tree is left untouched -- either it is genuinely added/removed, or
    its counterpart fell below the indexer's DETAIL_FLOOR (1 MiB) and was pruned
    from the detail tree, leaving the folder classified 'added'/'removed' with its
    sub-floor side understated by under DETAIL_FLOOR."""
    def walk(node):
        for c in node.get("children", []):
            walk(c)
        if node.get("other") or not node.get("path"):
            return
        st = node.get("status")
        if st == "added" and base_full is not None:
            bc = find_node(base_full, node["path"])
            if bc is not None:
                _restate_added(node, bc)
        elif st == "removed" and cur_full is not None:
            cc = find_node(cur_full, node["path"])
            if cc is not None:
                _restate_removed(node, cc)
    walk(tree)


def compare_subtree(cur_sub, base_sub):
    """Diff one matched directory pair into a delta subtree, for lazy drill-in
    within the compare view (op=compare&path=...). Both sides are expected to be
    already folded the same way (e.g. via aggregate.build_lazy); exactly one may
    be None for an added (base None) or removed (cur None) subtree.

    Returns just the delta tree node -- the self deltas, change list and summary
    that compare() also produces are not needed for the chart and stay owned by
    the top-level whole-tree compare. _diff_node fills every field the compare
    sunburst reads (status, base_*, d_*, files_top), so the grafted children
    colour and tool-tip exactly like the eagerly-loaded ones."""
    return _build(cur_sub, base_sub)


def compare(base_root, cur_root, base_full_loader=None, cur_full_loader=None):
    """Diff two `(scan)` tree roots. Returns the structure served by op=compare.

    base/cur_full_loader, when given, are zero-arg callables returning the full
    (unfolded) tree for that side. They are invoked only when the diff has an
    added/removed directory that might be a fold-boundary crossing, then used to
    restate such folders as their true grew/shrank delta (see _reconcile_boundary)
    -- so the change table and delta map agree with the full-tree drill-in. A
    clean diff, or one whose only changes are genuine adds/removes, pays nothing
    on the side that can't have a boundary case.

    `reconcile_degraded` in the result is True when a side HAD fold-boundary
    candidates but its loader returned None (a missing/unreadable full tree): the
    diff then keeps the un-reconciled classification for those dirs, so the result
    is PROVISIONAL and the caller should serve it no-cache rather than pin a
    transient miss for a day."""
    tree = _build(cur_root, base_root)

    degraded = False
    if base_full_loader or cur_full_loader:
        has_added, has_removed = _boundary_candidates(tree)
        base_full = cur_full = None
        if has_added and base_full_loader:
            base_full = base_full_loader()
            degraded = degraded or base_full is None
        if has_removed and cur_full_loader:
            cur_full = cur_full_loader()
            degraded = degraded or cur_full is None
        if base_full is not None or cur_full is not None:
            _reconcile_boundary(tree, base_full, cur_full)

    changes, counts = [], {}
    _collect(tree, None, changes, counts)
    changes.sort(key=lambda c: c["self_actual"], reverse=True)

    base_tot = _totals(base_root)
    cur_tot = _totals(cur_root)
    return {
        "summary": {
            "base_total": base_tot,
            "cur_total": cur_tot,
            "delta": {k: cur_tot[k] - base_tot[k] for k in cur_tot},
            "counts": {
                "grew": counts.get("grew", 0),
                "shrank": counts.get("shrank", 0),
                "added": counts.get("added", 0),
                "removed": counts.get("removed", 0),
                "unchanged": counts.get("unchanged", 0),
            },
        },
        "changes": changes,
        "tree": tree,
        "reconcile_degraded": degraded,
    }
