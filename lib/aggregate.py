"""Fold a full directory tree down to a bounded, browsable size.

The indexer (indexer.py) produces a detail tree with one node per directory
above ~1 MiB. That can still be tens of thousands of nodes, so the overview
served to the browser is aggregated here: capped in depth, and small children
collapsed into a synthetic "(other)" bucket.

A child is kept (vs. folded) by an absolute-ish size threshold -- a fraction
of its scan root -- NOT by rank, so a directory near the boundary does not
flip in and out of "(other)" between scans and create spurious diff rows.

Every node carries the indexer's metrics, which the (other) bucket sums:
  size_actual/apparent, exclusive_actual/apparent, copy_actual/apparent, count
"""

import json
import sys

# Overview: the whole filesystem, shallow. Lazy: a drilled subtree, wide.
# LAZY.max_children is high so a single drill returns a directory's whole child
# set: the UI caps RENDERED slices by angular width, so there is no benefit to a
# server-side rank cap -- and a low cap left a residual "(other)" bucket that the
# client could never expand past (it re-grafted the same capped set forever).
OVERVIEW = {"depth_cap": 9, "max_children": 250, "min_size_ratio": 0.0005,
            "files_top_cap": 6}
# Compare uses the SAME directory folding as the overview (so the directory-level
# diff is identical) but keeps a deeper per-dir file list, so file-level changes
# are meaningful. Only used by op_compare, never served to the dashboard.
COMPARE = {"depth_cap": 9, "max_children": 250, "min_size_ratio": 0.0005,
           "files_top_cap": 100}
# The lazy (drill-in) file cap is high but bounded: high enough that drilling a
# file-heavy directory reveals far more files than the overview's 6 (so the
# "+N files" wedge actually shrinks on drill), bounded so one directory's
# response can't balloon under a low STRATA_FILE_FLOOR.
LAZY = {"depth_cap": 3, "max_children": 5000, "min_size_ratio": 0.0,
        "files_top_cap": 500}

_SUM_FIELDS = (
    "size_actual", "size_apparent",
    "exclusive_actual", "exclusive_apparent",
    "copy_actual", "copy_apparent",
    "count",
)


def _blank(node):
    """A shallow copy of `node`'s scalar fields with an empty child list."""
    out = {
        "name": node.get("name"),
        "path": node.get("path"),
        "truncated": False,
        "children": [],
    }
    for f in _SUM_FIELDS:
        out[f] = node.get(f, 0) or 0
    # own_count / files_top describe THIS directory's own loose files, so they
    # ride along unchanged (not summed). The synthetic "(other)" bucket -- built
    # separately in _aggregate, never via _blank -- deliberately carries neither.
    if "own_count" in node:
        out["own_count"] = node.get("own_count", 0) or 0
    if node.get("files_top"):
        out["files_top"] = node["files_top"]
    if node.get("other"):
        out["other"] = True
        out["other_dirs"] = node.get("other_dirs", 0)
    return out


def _raw_size(node):
    # Rank/floor key: deduped + copy bytes. Matches the indexer's DETAIL_FLOOR
    # key (lib/indexer.py:_to_node) so a directory made entirely of hard-link
    # copies -- deduped size_actual 0 -- isn't quietly folded into "(other)"
    # at the overview stage after the indexer deliberately kept it browsable.
    return (node.get("size_actual", 0) or 0) + (node.get("copy_actual", 0) or 0)


def _aggregate(node, opts, depth, root_total):
    """Recursively fold one detail-tree node into an overview node."""
    out = _blank(node)
    # The eagerly-loaded overview tree is served uncompressed, so cap its
    # per-node files_top; the chart only renders a few file slices per dir, and
    # the wider lazy (drill-in) response still carries the full list.
    cap = opts.get("files_top_cap")
    if cap is not None and out.get("files_top"):
        out["files_top"] = out["files_top"][:cap]
    kids = node.get("children") or []

    if depth >= opts["depth_cap"]:
        out["truncated"] = bool(kids)
        return out
    if not kids:
        return out

    # Partition raw kids first; folding a child only to drop it into the
    # "(other)" bucket would discard the entire recursion below it.
    floor = root_total * opts["min_size_ratio"]
    ranked = sorted(kids, key=_raw_size, reverse=True)
    keep_raw, rest_raw = [], []
    for i, c in enumerate(ranked):
        if i < opts["max_children"] and _raw_size(c) >= floor:
            keep_raw.append(c)
        else:
            rest_raw.append(c)
    if len(rest_raw) == 1:  # a lone leftover is not worth an "(other)" bucket
        keep_raw.append(rest_raw.pop())

    keep = [_aggregate(c, opts, depth + 1, root_total) for c in keep_raw]

    if rest_raw:
        bucket = {
            "name": "(other)", "other": True, "other_dirs": len(rest_raw),
            "path": node.get("path"), "truncated": True, "children": [],
        }
        for f in _SUM_FIELDS:
            bucket[f] = sum((c.get(f, 0) or 0) for c in rest_raw)
        keep.append(bucket)
        out["truncated"] = True

    out["children"] = keep
    return out


def build_overview(detail_root):
    """Aggregate the indexer's detail tree into the overview served to the UI.

    Each scan root is folded against its own size, so a tiny directory is
    judged relative to the pool it lives in, not the whole scan.
    """
    out = _blank(detail_root)
    for scan_root in detail_root.get("children") or []:
        out["children"].append(
            _aggregate(scan_root, OVERVIEW, 1, _raw_size(scan_root) or 1)
        )
    return out


def build_lazy(subtree):
    """Aggregate a drilled-into subtree (shallow + wide) for lazy loading."""
    return _aggregate(subtree, LAZY, 0, _raw_size(subtree) or 1)


def build_compare(detail_root):
    """Like build_overview but with a deeper per-dir file list, for file-level
    diffing. The directory topology is identical to the overview."""
    out = _blank(detail_root)
    for scan_root in detail_root.get("children") or []:
        out["children"].append(
            _aggregate(scan_root, COMPARE, 1, _raw_size(scan_root) or 1)
        )
    return out


def main(argv):
    """CLI: aggregate.py <detail-tree.json>  ->  overview on stdout."""
    if len(argv) < 2:
        sys.stderr.write("usage: aggregate.py <detail-tree.json>\n")
        return 2
    with open(argv[1]) as f:
        detail = json.load(f)
    json.dump(build_overview(detail), sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
