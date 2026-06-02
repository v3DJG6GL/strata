"""Inode-aware filesystem indexer for Strata.

Walks the configured directories and attributes hard-linked files
deliberately:

  * every inode's bytes are counted exactly once (the industry-standard dedup);
  * the directory an inode counts under is the highest-priority one among its
    links (STRATA_HARDLINK_PRIORITY), falling back to the first link encountered;
  * each directory also reports `exclusive` bytes -- bytes whose every hard
    link lives inside that subtree, i.e. what is actually reclaimed if the
    directory is deleted -- and `copy` bytes, the redundant links that were
    counted under another directory.

Hard links carry no per-link identity or creation date (all links to an inode
are equal and share one set of inode timestamps), so attribution is by
directory rule, never by "which link is older".

Output (written to <out>/):
  strata-<ts>.full.json.gz   detail tree (directories >= DETAIL_FLOOR), for lazy
  strata-<ts>.tree.json      aggregated overview tree (via aggregate.py)
  strata-<ts>.totals.json    per-root and combined totals, for scan_stats.py

CLI:  indexer.py --ts <ts> --out <dir> --progress <file>
      (scan paths come from STRATA_SCAN_PATHS, rules from STRATA_HARDLINK_PRIORITY)
"""

import gzip
import heapq
import json
import os
import re
import sys
import time

import aggregate

# Directories whose whole subtree is smaller than this are not emitted as
# their own nodes in the detail tree -- their bytes still count in the parent.
DETAIL_FLOOR = 1 << 20  # 1 MiB
# Per-directory, retain individual loose files so the UI can surface big files
# as their own chart slices rather than folding every file into one opaque "own
# files" wedge. A file is kept if it is among the STRATA_FILE_TOP biggest (rank
# rule, candidates >= FILES_TOP_FLOOR) OR at least STRATA_FILE_FLOOR bytes (size
# rule) -- the union. own_count stays exact regardless of what is kept.
FILES_TOP_K = 12             # default STRATA_FILE_TOP
FILES_TOP_FLOOR = 256 << 10  # 256 KiB: a tiny file is never a "biggest" candidate
# Hard ceiling on files stored per directory even under a low size floor, so a
# pathological directory can't blow up indexer memory / the snapshot. The file
# *count* (own_count) is unaffected -- only the browsable list is bounded.
FILES_STORE_CEILING = 50_000
# Live config, set once from the environment in run_index (read here, never in
# the per-file hot loop): top-K count and the optional size floor (None = off).
_file_top = FILES_TOP_K
_file_floor = None
# Minimum seconds between progress-file updates.
PROGRESS_EVERY = 0.7


class Dir:
    """A directory while indexing. `o_*` are bytes attributed directly here;
    the plain fields become subtree totals in finalize()."""

    __slots__ = (
        "name", "parent", "depth", "children",
        "o_sa", "o_sk", "o_ex_sa", "o_ex_sk", "o_cp_sa", "o_cp_sk", "o_files",
        "o_files_top", "o_files_floor",
        "sa", "sk", "ex_sa", "ex_sk", "cp_sa", "cp_sk", "files", "dirs",
    )

    def __init__(self, name, parent, depth):
        self.name = name
        self.parent = parent
        self.depth = depth
        self.children = {}
        self.o_sa = self.o_sk = 0          # own deduped size (apparent/actual)
        self.o_ex_sa = self.o_ex_sk = 0    # own exclusive (attributed at LCA)
        self.o_cp_sa = self.o_cp_sk = 0    # own redundant-copy bytes
        self.o_files = 0
        self.o_files_top = []              # min-heap: top-K largest loose files (rank rule)
        self.o_files_floor = []            # min-heap: loose files >= floor (size rule)
        self.sa = self.sk = 0
        self.ex_sa = self.ex_sk = 0
        self.cp_sa = self.cp_sk = 0
        self.files = self.dirs = 0


def dir_path(d):
    """Absolute filesystem path of a directory node (scan roots store their
    own absolute path as `name`)."""
    parts = []
    while d is not None and d.parent is not None:
        parts.append(d.name)
        d = d.parent
    if not parts:
        return ""
    parts.reverse()
    head = parts[0].rstrip("/")
    return head + ("/" + "/".join(parts[1:]) if len(parts) > 1 else "")


def _bounded_push(heap, cap, sk, sa, name, nlink):
    """Keep the `cap` largest entries in a bounded min-heap, keyed by on-disk
    size. The tuple is fully comparable (sk, sa, name, nlink), so files of equal
    size never fall back to comparing an unorderable type."""
    item = (sk, sa, name, nlink)
    if len(heap) < cap:
        heapq.heappush(heap, item)
    else:
        heapq.heappushpop(heap, item)


def _keep_file(node, sk, sa, name, nlink):
    """Record a loose file for `node`'s 'largest files' lists: the top-K biggest
    (rank rule) and/or every file >= the configured size floor (size rule). The
    two heaps are unioned (deduped by name) at serialization. own_count is
    counted separately and stays exact no matter what these lists keep."""
    if _file_top > 0 and sk >= FILES_TOP_FLOOR:
        _bounded_push(node.o_files_top, _file_top, sk, sa, name, nlink)
    if _file_floor is not None and sk >= _file_floor:
        _bounded_push(node.o_files_floor, FILES_STORE_CEILING, sk, sa, name, nlink)


# --------------------------------------------------------------------------
# the walk
# --------------------------------------------------------------------------

def _walk(node, path, hardlinks, ctr, progress):
    """Depth-first scan of `path` into directory node `node`."""
    try:
        scan = os.scandir(path)
    except OSError:
        return
    # Collect child dirs during the scandir loop and recurse *after* the
    # handle closes; recursing inside `with scan:` keeps one FD open per
    # ancestor, which on a deep tree (default ulimit 1024) trips ENFILE
    # and the OSError branch silently drops subtrees → undercounted totals.
    pending = []
    with scan:
        while True:
            try:
                entry = next(scan)
            except StopIteration:
                break
            except OSError:
                continue
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False

            if is_dir:
                child = Dir(entry.name, node, node.depth + 1)
                node.children[entry.name] = child
                ctr[1] += 1  # directories
                pending.append((child, entry.path))
                continue

            # a file (regular / symlink / fifo / socket / device ...)
            try:
                st = entry.stat(follow_symlinks=False)
            except OSError:
                continue
            sa = st.st_size
            sk = st.st_blocks * 512
            node.o_files += 1
            ctr[0] += 1  # files

            if st.st_nlink > 1:
                # defer: the canonical link can only be chosen once every
                # link to this inode has been seen. Carry the entry name so the
                # file can be listed under its canonical directory later.
                key = (st.st_dev, st.st_ino)
                rec = hardlinks.get(key)
                if rec is None:
                    hardlinks[key] = [sa, sk, [(node, entry.name)]]
                else:
                    rec[2].append((node, entry.name))
            else:
                node.o_sa += sa
                node.o_sk += sk
                node.o_ex_sa += sa
                node.o_ex_sk += sk
                # A single-link file is unambiguously owned here (deduped,
                # exclusive, canonical all coincide), so it can be surfaced as
                # its own slice without any hard-link accounting caveat.
                _keep_file(node, sk, sa, entry.name, 1)

            if (ctr[0] & 0x3FFF) == 0:
                progress(ctr, path)

    for child, child_path in pending:
        _walk(child, child_path, hardlinks, ctr, progress)


def _precount_walk(path, ctr, progress):
    """Count files (non-dir entries) under `path`, scandir + d_type only.

    Mirrors _walk's FD-careful pattern (defer recursion until the handle
    closes) and its error handling (drop an unreadable subtree, treat an entry
    whose type can't be read as a file), so the total lines up with what the
    real walk sees -- both passes fail on exactly the same directories. No
    stat() here, which is what makes the pre-pass much cheaper than the walk."""
    try:
        scan = os.scandir(path)
    except OSError:
        return
    pending = []
    with scan:
        while True:
            try:
                entry = next(scan)
            except StopIteration:
                break
            except OSError:
                continue
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            if is_dir:
                pending.append(entry.path)
            else:
                ctr[0] += 1
                if (ctr[0] & 0x3FFF) == 0:
                    progress(ctr[0])
    for child_path in pending:
        _precount_walk(child_path, ctr, progress)


def _precount(scan_paths, progress):
    """Total file count across all scan roots (cheap scandir-only pre-pass)."""
    ctr = [0]
    for p in scan_paths:
        p = p.rstrip("/") or "/"
        if os.path.isdir(p):
            _precount_walk(p, ctr, progress)
    return ctr[0]


# --------------------------------------------------------------------------
# hard-link resolution
# --------------------------------------------------------------------------

def _lca(dirs):
    """Lowest common ancestor directory node of a set of directory nodes."""
    it = iter(dirs)
    node = next(it)
    for other in it:
        a, b = node, other
        while a.depth > b.depth:
            a = a.parent
        while b.depth > a.depth:
            b = b.parent
        while a is not b:
            a = a.parent
            b = b.parent
        node = a
    return node


def link_tier(path, priority, copies):
    """Sort key (tier, sub-index) for a hard link's directory:

      tier 0  link inside a STRATA_HARDLINK_PRIORITY directory  (the "original")
      tier 1  link inside a directory listed in neither
      tier 2  link inside a STRATA_HARDLINK_COPIES directory     (a "copy")

    The longest matching prefix decides the tier, so a copy directory nested
    inside a priority directory (or vice versa) is classed by the more
    specific rule; an exact-length tie favours priority.
    """
    best_len = -1
    tier = (1, 0)  # default: listed in neither
    for i, prefix in enumerate(priority):
        if (path == prefix or path.startswith(prefix + "/")) and len(prefix) > best_len:
            best_len = len(prefix)
            tier = (0, i)
    for i, prefix in enumerate(copies):
        if (path == prefix or path.startswith(prefix + "/")) and len(prefix) > best_len:
            best_len = len(prefix)
            tier = (2, i)
    return tier


def _resolve_hardlinks(hardlinks, priority, copies):
    """Attribute every multi-linked inode: one canonical directory (deduped
    size), the rest copies, and the exclusive contribution at the LCA."""
    ranked = bool(priority or copies)
    for sa, sk, links in hardlinks.values():
        # links is a list of (dir node, entry name) for every link seen.
        nodes = [ln[0] for ln in links]
        # canonical = the best-tier link; ties keep walk order (first seen).
        if ranked:
            # dir_path walks up to the root and link_tier scans the priority
            # list, so precompute both once per link rather than once per
            # min(key=) comparison (matters for inodes with many links, e.g.
            # backup-style snapshot trees).
            tiers = [link_tier(dir_path(n), priority, copies) for n in nodes]
            best = min(range(len(nodes)), key=lambda i: tiers[i] + (i,))
        else:
            best = 0
        canonical = nodes[best]

        used = False
        for n in nodes:
            if n is canonical and not used:
                used = True
                n.o_sa += sa
                n.o_sk += sk
            else:
                n.o_cp_sa += sa
                n.o_cp_sk += sk

        lca = _lca(set(nodes))
        lca.o_ex_sa += sa
        lca.o_ex_sk += sk

        # The canonical directory owns this inode's deduped bytes, so list the
        # file there (named by its link in that dir) among its largest files.
        # nlink>1 lets the UI fold it back into the remainder in exclusive mode,
        # where the file's exclusive bytes belong to its LCA, not the canonical
        # dir, and a full-size leaf would overcount.
        _keep_file(canonical, sk, sa, links[best][1], len(links))


# --------------------------------------------------------------------------
# subtree sums + serialisation
# --------------------------------------------------------------------------

def _finalize(node):
    """Bottom-up: turn own_* accumulators into subtree totals."""
    node.sa, node.sk = node.o_sa, node.o_sk
    node.ex_sa, node.ex_sk = node.o_ex_sa, node.o_ex_sk
    node.cp_sa, node.cp_sk = node.o_cp_sa, node.o_cp_sk
    node.files = node.o_files
    node.dirs = 0
    for child in node.children.values():
        _finalize(child)
        node.sa += child.sa
        node.sk += child.sk
        node.ex_sa += child.ex_sa
        node.ex_sk += child.ex_sk
        node.cp_sa += child.cp_sa
        node.cp_sk += child.cp_sk
        node.files += child.files
        node.dirs += 1 + child.dirs


def _to_node(d, path):
    """Serialise a Dir subtree to plain dicts, pruning directories below
    DETAIL_FLOOR (their bytes remain counted in the ancestor totals)."""
    children = []
    # Rank/prune by raw size (deduped + copies) so a directory made entirely
    # of hard-link copies -- deduped size 0 -- is still kept and browsable.
    for c in sorted(d.children.values(), key=lambda x: x.sk + x.cp_sk, reverse=True):
        if c.sk + c.cp_sk < DETAIL_FLOOR:
            continue
        children.append(_to_node(c, path.rstrip("/") + "/" + c.name))
    return {
        "name": d.name,
        "path": path,
        "size_actual": d.sk,
        "size_apparent": d.sa,
        "exclusive_actual": d.ex_sk,
        "exclusive_apparent": d.ex_sa,
        "copy_actual": d.cp_sk,
        "copy_apparent": d.cp_sa,
        "count": d.files,
        # own_count is files held DIRECTLY here (not the subtree `count`); it is
        # the item count for the "own files" remainder wedge. files_top lets the
        # UI promote the largest loose files to their own slices.
        "own_count": d.o_files,
        "files_top": _union_files(d),
        "truncated": False,
        "children": children,
    }


def _union_files(d):
    """The serialized 'largest files' list for a directory: the union of the
    rank heap (top-K) and the size-floor heap, deduped by name (filenames are
    unique within a directory) and sorted largest-first."""
    by_name = {}
    for (fsk, fsa, name, nl) in d.o_files_top:
        by_name[name] = (fsk, fsa, nl)
    for (fsk, fsa, name, nl) in d.o_files_floor:
        by_name[name] = (fsk, fsa, nl)
    return [
        {"name": name, "size_actual": fsk, "size_apparent": fsa, "nlink": nl}
        for name, (fsk, fsa, nl) in sorted(
            by_name.items(), key=lambda kv: kv[1][0], reverse=True
        )
    ]


# --------------------------------------------------------------------------
# top level
# --------------------------------------------------------------------------

def _dir_list(env_name):
    """Parse a newline-separated directory-prefix list from an env var."""
    raw = os.environ.get(env_name, "")
    return [ln.strip().rstrip("/") for ln in raw.splitlines() if ln.strip()]


def hardlink_priority():
    """Directories whose hard links are preferred as the canonical original."""
    return _dir_list("STRATA_HARDLINK_PRIORITY")


def hardlink_copies():
    """Directories whose hard links are ranked last (treated as copies)."""
    return _dir_list("STRATA_HARDLINK_COPIES")


def _parse_size(raw):
    """Parse a human size ('512K', '100M', '1G', '0') into bytes (base-1024, to
    match the app's IEC labels). '0' -> 0 (every file). Empty/unset/invalid ->
    None (size floor disabled)."""
    s = (raw or "").strip()
    if not s:
        return None
    m = re.match(r"^(\d+(?:\.\d+)?)\s*([KMGT]?)(?:i?B)?$", s, re.IGNORECASE)
    if not m:
        sys.stderr.write("indexer: invalid STRATA_FILE_FLOOR %r; ignoring\n" % raw)
        return None
    mult = {"": 1, "K": 1 << 10, "M": 1 << 20, "G": 1 << 30, "T": 1 << 40}
    return int(float(m.group(1)) * mult[m.group(2).upper()])


def file_top():
    """How many of the largest loose files to keep per directory (0 = none)."""
    raw = os.environ.get("STRATA_FILE_TOP", "").strip()
    if not raw:
        return FILES_TOP_K
    try:
        return max(0, int(raw))
    except ValueError:
        sys.stderr.write(
            "indexer: invalid STRATA_FILE_TOP %r; using %d\n" % (raw, FILES_TOP_K)
        )
        return FILES_TOP_K


def file_floor():
    """Size floor: additionally store every loose file at least this big (bytes),
    or None when STRATA_FILE_FLOOR is unset/invalid."""
    return _parse_size(os.environ.get("STRATA_FILE_FLOOR"))


def run_index(scan_paths, priority, copies, progress_path=None, precount=False,
              file_top_k=FILES_TOP_K, file_floor_bytes=None):
    """Walk every scan path. Returns the detail-tree root node (dict).

    When `precount` is set, a cheap scandir-only pre-pass counts every file
    first so live progress has an exact denominator. It is off by default
    because on large spinning-disk trees that second metadata pass can rival
    the walk itself; the API instead estimates % from the previous snapshot."""
    # Publish the per-file retention config for _keep_file (read once here, not
    # in the hot loop). Embedding callers get the defaults unless they pass them.
    global _file_top, _file_floor
    _file_top = file_top_k
    _file_floor = file_floor_bytes

    # _walk / _finalize / _to_node all recurse with the filesystem; lift the
    # guard here so embedding callers inherit it, not just the CLI entry.
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))

    index_start = time.time()
    last = [0.0]
    phase_start = [index_start]

    def write_progress(phase, files, dirs, cur_path, total, force=False):
        # Atomic JSON: api.cgi reads this file concurrently, so write a temp
        # and rename it into place -- a half-written file would otherwise make
        # the live panel flicker to "no progress".
        if not progress_path:
            return
        now = time.time()
        if not force and now - last[0] < PROGRESS_EVERY:
            return
        last[0] = now
        doc = {
            "phase": phase,                  # 'counting' | 'indexing'
            "files": files,
            "dirs": dirs,
            "total": total,
            "path": cur_path or "",
            "index_start_epoch": index_start,
            "phase_start_epoch": phase_start[0],
        }
        tmp = progress_path + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump(doc, f, separators=(",", ":"))
            os.replace(tmp, progress_path)
        except OSError:
            pass

    total = None
    if precount:
        # Optional pre-count phase: an exact denominator at the cost of a full
        # extra metadata pass. It may slightly overshoot the real count (it
        # counts files whose stat() later fails, which _walk skips); op_status
        # clamps for that.
        write_progress("counting", 0, None, "", None, force=True)

        def count_progress(n):
            write_progress("counting", n, None, "", None)

        total = _precount(scan_paths, count_progress)
        write_progress("counting", total, None, "", total, force=True)
        # Reset phase_start so the ETA is measured from when indexing began,
        # not from the start of counting.
        phase_start[0] = time.time()
    else:
        # No pre-count: publish an 'indexing' doc immediately so the first
        # status poll reads a valid file (no empty-file window). The API
        # supplies the denominator from the previous snapshot's file count.
        write_progress("indexing", 0, None, "", None, force=True)

    root = Dir("(scan)", None, 0)
    hardlinks = {}
    ctr = [0, 0]  # [files, dirs]

    def progress(c, cur_path="", force=False):
        write_progress("indexing", c[0], c[1], cur_path, total, force=force)

    for p in scan_paths:
        p = p.rstrip("/") or "/"
        if not os.path.isdir(p):
            sys.stderr.write("indexer: skipping missing path %s\n" % p)
            continue
        child = Dir(p, root, 1)
        root.children[p] = child
        ctr[1] += 1
        _walk(child, p, hardlinks, ctr, progress)

    _resolve_hardlinks(hardlinks, priority, copies)
    _finalize(root)
    progress(ctr, force=True)  # final tally — bypass throttle

    detail = {
        "name": "(scan)", "path": "",
        "size_actual": root.sk, "size_apparent": root.sa,
        "exclusive_actual": root.ex_sk, "exclusive_apparent": root.ex_sa,
        "copy_actual": root.cp_sk, "copy_apparent": root.cp_sa,
        "count": root.files, "truncated": False,
        "children": [
            _to_node(c, c.name)
            for c in sorted(root.children.values(), key=lambda x: x.sk, reverse=True)
        ],
    }
    totals = {
        "roots": [
            {
                "path": c.name,
                "files": c.files,
                "dirs": c.dirs,
                "size_actual": c.sk,
                "size_apparent": c.sa,
                "exclusive_actual": c.ex_sk,
                "copy_actual": c.cp_sk,
            }
            for c in sorted(root.children.values(), key=lambda x: x.sk, reverse=True)
        ],
        "total": {
            "files": root.files,
            "dirs": root.dirs,
            "size_actual": root.sk,
            "size_apparent": root.sa,
            "exclusive_actual": root.ex_sk,
            "copy_actual": root.cp_sk,
        },
    }
    return detail, totals


def main(argv):
    ts = out = progress = None
    i = 1
    while i < len(argv):
        if argv[i] == "--ts":
            ts = argv[i + 1]; i += 2
        elif argv[i] == "--out":
            out = argv[i + 1]; i += 2
        elif argv[i] == "--progress":
            progress = argv[i + 1]; i += 2
        else:
            i += 1
    if not ts or not out:
        sys.stderr.write("usage: indexer.py --ts <ts> --out <dir> [--progress <file>]\n")
        return 2
    # ts is interpolated into the output artifact filenames below; validate its
    # shape here so a caller can never steer the writes outside --out via path
    # separators or '..'. The scan loop always supplies a date stamp, but the
    # consumer (cgi/api.cgi artifact()) validates too -- don't rely on callers.
    if not re.match(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}\Z", ts):
        sys.stderr.write("indexer: invalid --ts (expected YYYY-MM-DD_HH-MM)\n")
        return 2

    scan_paths = os.environ.get("STRATA_SCAN_PATHS", "").split()
    if not scan_paths:
        sys.stderr.write("indexer: STRATA_SCAN_PATHS is empty\n")
        return 1

    precount = os.environ.get("STRATA_SCAN_PRECOUNT", "").strip().lower() in (
        "1", "true", "yes", "on"
    )
    detail, totals = run_index(
        scan_paths, hardlink_priority(), hardlink_copies(), progress, precount,
        file_top(), file_floor()
    )

    with gzip.open(os.path.join(out, "strata-%s.full.json.gz" % ts), "wt") as f:
        json.dump(detail, f, separators=(",", ":"))
    with open(os.path.join(out, "strata-%s.tree.json" % ts), "w") as f:
        json.dump(aggregate.build_overview(detail), f, separators=(",", ":"))
    with open(os.path.join(out, "strata-%s.totals.json" % ts), "w") as f:
        json.dump(totals, f, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
