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
OVERVIEW = {"depth_cap": 9, "max_children": 250, "min_size_ratio": 0.0005}
LAZY = {"depth_cap": 3, "max_children": 600, "min_size_ratio": 0.0}

_SUM_FIELDS = (
    "size_actual", "size_apparent",
    "exclusive_actual", "exclusive_apparent",
    "copy_actual", "copy_apparent",
    "count",
)


def _blank(node, status_keep=True):
    """A shallow copy of `node`'s scalar fields with an empty child list."""
    out = {
        "name": node.get("name"),
        "path": node.get("path"),
        "truncated": False,
        "children": [],
    }
    for f in _SUM_FIELDS:
        out[f] = node.get(f, 0) or 0
    if node.get("other"):
        out["other"] = True
        out["other_dirs"] = node.get("other_dirs", 0)
    return out


def _aggregate(node, opts, depth, root_total):
    """Recursively fold one detail-tree node into an overview node."""
    out = _blank(node)
    kids = node.get("children") or []

    if depth >= opts["depth_cap"]:
        out["truncated"] = bool(kids)
        return out
    if not kids:
        return out

    folded = [_aggregate(c, opts, depth + 1, root_total) for c in kids]
    folded.sort(key=lambda k: k["size_actual"], reverse=True)

    floor = root_total * opts["min_size_ratio"]
    keep, rest = [], []
    for i, k in enumerate(folded):
        if i < opts["max_children"] and k["size_actual"] >= floor:
            keep.append(k)
        else:
            rest.append(k)
    if len(rest) == 1:  # a lone leftover is not worth an "(other)" bucket
        keep.append(rest.pop())

    if rest:
        bucket = {
            "name": "(other)", "other": True, "other_dirs": len(rest),
            "path": node.get("path"), "truncated": True, "children": [],
        }
        for f in _SUM_FIELDS:
            bucket[f] = sum(k.get(f, 0) for k in rest)
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
            _aggregate(scan_root, OVERVIEW, 1, scan_root.get("size_actual", 1) or 1)
        )
    return out


def build_lazy(subtree):
    """Aggregate a drilled-into subtree (shallow + wide) for lazy loading."""
    return _aggregate(subtree, LAZY, 0, subtree.get("size_actual", 1) or 1)


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
