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
    }
    return node


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
            child_sum = sum(c["d_" + m] for c in node["children"])
            node["self_" + m] = node["d_" + m] - child_sum
        if abs(node["self_actual"]) > EPS or node["d_count"] != 0:
            changes.append(_change(node))


def _change(node):
    """The flat per-directory record consumed by the diff table."""
    return {
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


def compare(base_root, cur_root):
    """Diff two `(scan)` tree roots. Returns the structure served by op=compare."""
    tree = _build(cur_root, base_root)

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
    }
