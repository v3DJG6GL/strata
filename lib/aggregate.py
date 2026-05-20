"""Build aggregated directory trees from a duc database.

A full duc scan can hold millions of directories -- far too many to ship to a
browser. This module streams `duc xml -x` and folds the tree down to a bounded
size: each directory keeps only its largest children, the rest collapse into a
synthetic "(other)" bucket, and the tree is capped at a maximum depth. Nodes
that were folded or depth-capped are marked `truncated`, so the frontend can
lazily fetch finer detail on demand.

Node shape (one dict per directory):
    name, path, size_actual, size_apparent, count, truncated, children[]
An "(other)" bucket additionally carries: other=True, other_dirs=<n folded>.

CLI:
    python3 aggregate.py <db>                 -> overview tree (all roots)
    python3 aggregate.py <db> --path <abspath> -> lazy subtree for one path
"""

import json
import sys
import xml.etree.ElementTree as ET

import duc_export as duc

# Overview tree: built once per scan, covers the whole filesystem shallowly.
OVERVIEW = {"depth_cap": 9, "max_children": 60, "min_size_ratio": 0.0005}
# Lazy subtree: fetched on drill-down, a few levels deep but wide.
LAZY = {"depth_cap": 3, "max_children": 200, "min_size_ratio": 0.0}


def _finalize(frame, opts, root_total):
    """Collapse one parsed directory frame into a finalized node dict."""
    a = frame["attrs"]
    node = {
        "name": frame["name"],
        "path": frame["path"],
        "size_actual": int(a.get("size_actual", 0)),
        "size_apparent": int(a.get("size_apparent", 0)),
        "count": int(a.get("count", 0)),
        "truncated": False,
        "children": [],
    }
    kids = frame["kids"]
    # At or past the depth cap we keep the node but drop its subtree.
    if frame["depth"] >= opts["depth_cap"]:
        node["truncated"] = bool(kids)
        return node
    if not kids:
        return node

    kids.sort(key=lambda k: k["size_actual"], reverse=True)
    floor = root_total * opts["min_size_ratio"]
    keep, rest = [], []
    for i, k in enumerate(kids):
        if i < opts["max_children"] and k["size_actual"] >= floor:
            keep.append(k)
        else:
            rest.append(k)
    # A lone leftover is not worth an "(other)" bucket.
    if len(rest) == 1:
        keep.append(rest.pop())
    if rest:
        keep.append({
            "name": "(other)",
            "other": True,
            "other_dirs": len(rest),
            "path": frame["path"],  # expanding re-queries the parent path
            "size_actual": sum(k["size_actual"] for k in rest),
            "size_apparent": sum(k["size_apparent"] for k in rest),
            "count": sum(k["count"] for k in rest),
            "truncated": True,
            "children": [],
        })
        node["truncated"] = True
    node["children"] = keep
    return node


def build_subtree(db_path, path, opts, base_depth):
    """Stream `duc xml -x` for `path` and return its aggregated node.

    `base_depth` is the effective depth of `path` in the overall tree: 1 for a
    scan root sitting under the synthetic "(scan)" node, 0 for a lazy query
    whose result is grafted in by the frontend.
    """
    proc = duc.open_duc_xml(db_path, path)
    stack = []        # open directory frames
    root_total = [1]  # size of the <duc> element, for the min-size floor
    result = [None]

    context = ET.iterparse(proc.stdout, events=("start", "end"))
    for event, elem in context:
        tag = elem.tag
        if tag not in ("duc", "ent"):
            continue
        is_dir = (tag == "duc") or (elem.get("type") == "dir")

        if event == "start":
            if not is_dir:
                continue  # a file <ent> (shouldn't appear with -x) -- ignore
            depth = base_depth + len(stack)
            if tag == "duc":
                name = path
                node_path = path
                root_total[0] = max(int(elem.get("size_actual", 1)), 1)
            else:
                parent = stack[-1]
                name = elem.get("name", "")
                node_path = parent["path"].rstrip("/") + "/" + name
            stack.append({
                "name": name, "path": node_path, "attrs": dict(elem.attrib),
                "kids": [], "depth": depth, "elem": elem,
            })
        else:  # end
            if not is_dir:
                elem.clear()
                continue
            frame = stack.pop()
            node = _finalize(frame, opts, root_total[0])
            if stack:
                stack[-1]["kids"].append(node)
            else:
                result[0] = node
            # Detach the finished element so ElementTree can free it.
            elem.clear()
            if stack:
                try:
                    stack[-1]["elem"].remove(elem)
                except Exception:
                    pass

    duc.finish_duc_xml(proc)
    if result[0] is None:
        raise RuntimeError("duc xml produced no <duc> root for %s" % path)
    return result[0]


def build_overview(db_path):
    """Build the synthetic-root overview tree spanning every scanned root."""
    roots = duc.duc_info(db_path)
    children = []
    for r in roots:
        children.append(build_subtree(db_path, r["path"], OVERVIEW, base_depth=1))
    return {
        "name": "(scan)",
        "path": "",
        "size_actual": sum(c["size_actual"] for c in children),
        "size_apparent": sum(c["size_apparent"] for c in children),
        "count": sum(c["count"] for c in children),
        "truncated": False,
        "children": children,
    }


def build_lazy(db_path, path):
    """Build a shallow, wide subtree for a drill-down request."""
    return build_subtree(db_path, path, LAZY, base_depth=0)


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: aggregate.py <db> [--path <abspath>]\n")
        return 2
    db_path = argv[1]
    if len(argv) >= 4 and argv[2] == "--path":
        node = build_lazy(db_path, argv[3])
    else:
        node = build_overview(db_path)
    json.dump(node, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
