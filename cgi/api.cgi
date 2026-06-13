#!/usr/bin/env python3
"""JSON API for Strata (CGI, served by lighttpd).

Endpoints (GET cgi-bin/api.cgi?op=...):
  op=snapshots                 -> list of scans + summary stats
  op=status                    -> live scan progress (or {"scanning":false})
  op=stats&ts=<ts>             -> frozen per-scan stats
  op=tree&ts=<ts>              -> pre-built aggregated directory tree
  op=tree&ts=<ts>&path=<abs>   -> lazily aggregated subtree for a drill-down
  op=compare&base=<ts>&cur=<ts>           -> full delta tree + change list
  op=compare&base=<ts>&cur=<ts>&path=<abs> -> lazily diffed subtree (drill-down)

Every response is application/json; errors are returned as {"error": "..."}
with HTTP 200 so the frontend can handle them uniformly.
"""

import gzip
import json
import os
import re
import sys
import traceback
import zlib

sys.path.insert(0, os.environ.get("STRATA_LIB_DIR", "/app/lib"))

from urllib.parse import parse_qs

import textfmt as fmt
import aggregate
import scan_stats
import diff

DB_DIR = os.environ.get("STRATA_DB_DIR", "/var/lib/strata")
CURRENT_JSON = os.path.join(DB_DIR, "current-scan.json")
SAMPLES = os.path.join(DB_DIR, "current-scan.samples")
PROGRESS = os.path.join(DB_DIR, "progress.json")
NEXT_JSON = os.path.join(DB_DIR, "next-scan.json")

# \Z (not $) so a trailing newline -- ts=...%0A -- can't slip through the
# anchored validation; $ also matches just before a final newline in Python.
TS_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}\Z")
CLK_TCK = os.sysconf("SC_CLK_TCK") if hasattr(os, "sysconf") else 100


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def artifact(ts, suffix):
    """Path to a snapshot artifact, validating the snapshot id first."""
    if not TS_RE.match(ts or ""):
        raise ValueError("invalid snapshot id")
    return os.path.join(DB_DIR, "strata-%s%s" % (ts, suffix))


def list_snapshot_ts():
    """Snapshot ids that have an overview tree, newest first."""
    out = []
    try:
        for name in os.listdir(DB_DIR):
            if name.startswith("strata-") and name.endswith(".tree.json"):
                ts = name[len("strata-"):-len(".tree.json")]
                if TS_RE.match(ts):
                    out.append(ts)
    except OSError:
        pass
    out.sort(reverse=True)
    return out


def load_full_tree(ts):
    """The indexer's full detail tree for a snapshot (gzipped JSON)."""
    with gzip.open(artifact(ts, ".full.json.gz"), "rt") as f:
        return json.load(f)


def load_full_tree_or_none(ts):
    """load_full_tree, but None instead of raising when the snapshot's detail
    artifact is absent or unreadable. Lets a drill into a pruned/half-removed
    snapshot return a clean "path not found" envelope rather than the generic
    "internal error" the blanket handler would otherwise surface."""
    try:
        return load_full_tree(ts)
    except (OSError, ValueError, zlib.error, EOFError):
        # gzip.open + json.load raise OSError (incl. gzip.BadGzipFile) / ValueError
        # (JSONDecodeError) for a missing or malformed file, but a corrupt deflate
        # stream surfaces as zlib.error and a truncated one (e.g. a scan killed
        # mid-write) as EOFError -- neither subclasses OSError/ValueError, so catch
        # them too or a half-written detail artifact fails the whole compare
        # instead of degrading to the un-reconciled (best-effort) classification.
        return None


def get_stats(ts):
    """Per-scan stats; rebuilt from the indexer totals if the sidecar is gone."""
    sidecar = artifact(ts, ".stats.json")
    try:
        with open(sidecar) as f:
            return json.load(f)
    except (OSError, ValueError):
        pass
    # Rebuild best-effort. Without start/end/samples we cannot recover
    # duration / io / rates, so we serve the partial record but DON'T cache
    # it -- otherwise a one-time absent sidecar locks the snapshot into a
    # permanently-incomplete state.
    return scan_stats.build_stats(artifact(ts, ".totals.json"))


def previous_total_files():
    """File count of the most recent completed snapshot, for the live %
    estimate. The in-progress scan has no tree.json yet, so the newest listed
    snapshot is the previous one. Returns None when there is no history."""
    tslist = list_snapshot_ts()
    if not tslist:
        return None
    try:
        st = get_stats(tslist[0])
        tot = (st.get("total") or {}).get("files")
        return int(tot) if tot else None
    except Exception:
        return None


def parse_progress():
    """The live progress doc, or None."""
    try:
        with open(PROGRESS) as f:
            doc = json.load(f)
        if isinstance(doc, dict) and "phase" in doc:
            return doc
    except (OSError, ValueError):
        pass
    return None


def tail_samples(n=2):
    """Return the last `n` sampler readings as parsed dicts."""
    out = []
    for ln in scan_stats.tail_lines(SAMPLES, n):
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------

def op_snapshots():
    scanning = os.path.exists(CURRENT_JSON)
    snapshots = []
    for ts in list_snapshot_ts():
        entry = {
            "ts": ts,
            "label": fmt.ts_label(ts),
            "db_bytes": None,
            "duration_sec": None,
            "total": None,
            "roots": None,
        }
        try:
            st = get_stats(ts)
            entry["duration_sec"] = st.get("duration_sec")
            entry["total"] = st.get("total")
            entry["roots"] = st.get("roots")
            entry["db_bytes"] = st.get("db_bytes")
        except Exception:
            pass
        snapshots.append(entry)
    return {"scanning": scanning, "snapshots": snapshots}


def op_status():
    import time
    now = time.time()

    try:
        with open(CURRENT_JSON) as f:
            cur = json.load(f)
    except (OSError, ValueError):
        # Idle: report when the next scan is due so the UI can count down.
        res = {"scanning": False, "server_now": int(now)}
        try:
            with open(NEXT_JSON) as f:
                nx = json.load(f)
            res["next_scan"] = nx.get("next")
            res["mode"] = nx.get("mode")
            res["schedule"] = nx.get("schedule")
            res["interval_sec"] = nx.get("interval_sec")
            res["tz"] = nx.get("tz")
        except (OSError, ValueError):
            pass
        return res

    start = cur.get("start")
    elapsed = max(0, int(now - start)) if start else None

    res = {
        "scanning": True,
        "ts": cur.get("ts"),
        "pid": cur.get("pid"),
        "paths": cur.get("paths"),
        "elapsed_sec": elapsed,
        "server_now": int(now),
        "phase": None,
        "current_path": None, "depth": None,
        "files": None, "dirs": None,
        "total": None, "percent": None, "eta_sec": None,
        "cpu_pct": None, "mem_mb": None, "cmem_mb": None, "status_desc": None,
        "read_bytes": None, "write_bytes": None, "read_rate": None, "write_rate": None,
        "db_bytes": None, "db_growth_rate": None,
    }

    doc = parse_progress() or {}
    res["phase"] = doc.get("phase")
    res["files"] = doc.get("files")
    res["dirs"] = doc.get("dirs")
    cur_path = doc.get("path")
    if cur_path:
        res["current_path"] = cur_path
        res["depth"] = max(0, cur_path.count("/"))

    # Denominator: the indexer's exact pre-count if it ran one, otherwise an
    # estimate from the most recent completed snapshot (the tree is re-scanned
    # regularly, so day-to-day file counts are stable). This lets us show a %
    # without a costly pre-count pass over large filesystems.
    files = res["files"]
    total = doc.get("total") or previous_total_files()
    res["total"] = total

    # Percent + ETA only make sense once indexing (a pre-count, if any, is done).
    if res["phase"] == "indexing" and total and files is not None:
        # Clamp below 100: a finished scan is signalled by current-scan.json
        # disappearing, not by percent hitting 100 (the estimate may be off).
        res["percent"] = min(99.9, max(0.0, files / total * 100.0))
        ps = doc.get("phase_start_epoch")
        if ps and files > 0 and total > files:
            el = now - ps
            if el > 0:
                res["eta_sec"] = int((total - files) / (files / el))

    samples = tail_samples(2)
    if samples:
        last = samples[-1]
        if "rss_kb" in last:
            res["mem_mb"] = round(last["rss_kb"] / 1024, 1)
        if "cmem_bytes" in last:
            res["cmem_mb"] = round(last["cmem_bytes"] / 1048576, 1)
        res["read_bytes"] = last.get("read_bytes")
        res["write_bytes"] = last.get("write_bytes")
        state = (last.get("state") or "")[:1]
        res["status_desc"] = {
            "R": "Active (using CPU)", "D": "Waiting for disk",
            "S": "Idle", "Z": "Zombie",
        }.get(state, state or None)
        if len(samples) >= 2:
            prev = samples[-2]
            dt = last.get("t", 0) - prev.get("t", 0)
            if dt > 0:
                if "utime" in last and "utime" in prev:
                    ticks = (last["utime"] + last["stime"]) - (prev["utime"] + prev["stime"])
                    res["cpu_pct"] = round(ticks / CLK_TCK / dt * 100, 1)
                if "read_bytes" in last and "read_bytes" in prev:
                    res["read_rate"] = round((last["read_bytes"] - prev["read_bytes"]) / dt / 1048576, 2)
                if "write_bytes" in last and "write_bytes" in prev:
                    res["write_rate"] = round((last["write_bytes"] - prev["write_bytes"]) / dt / 1048576, 2)

    return res


def op_stats(ts):
    return get_stats(ts)


def overview_tree(ts):
    """The pre-aggregated overview tree for a snapshot (built + cached)."""
    cached = artifact(ts, ".tree.json")
    try:
        with open(cached) as f:
            return json.load(f)
    except (OSError, ValueError):
        pass
    node = aggregate.build_overview(load_full_tree(ts))
    try:  # best-effort cache
        with open(cached, "w") as f:
            json.dump(node, f, separators=(",", ":"))
    except OSError:
        pass
    return node


def compare_tree(ts):
    """Like overview_tree but with a deeper per-dir file list, for file-level
    diffing (built + cached separately so the eager dashboard overview stays
    small). Same directory topology as the overview."""
    cached = artifact(ts, ".compare.json")
    try:
        with open(cached) as f:
            return json.load(f)
    except (OSError, ValueError):
        pass
    node = aggregate.build_compare(load_full_tree(ts))
    try:  # best-effort cache
        with open(cached, "w") as f:
            json.dump(node, f, separators=(",", ":"))
    except OSError:
        pass
    return node


def op_tree(ts, path):
    if path:
        full = load_full_tree_or_none(ts)
        sub = diff.find_node(full, path) if full is not None else None
        if sub is None:
            return {"ts": ts, "lazy": True, "error": "path not found in snapshot"}
        return {"ts": ts, "lazy": True, "node": aggregate.build_lazy(sub)}
    return {"ts": ts, "lazy": False, "node": overview_tree(ts)}


def op_compare(base_ts, cur_ts, path=""):
    # Lazy drill-in: diff just the subtree at `path`. The compare overview folds
    # small directories into "(other)" exactly like the dashboard overview, so a
    # truncated dir needs the same on-demand load the dashboard's op=tree gives --
    # otherwise the folded children can never be expanded (an "(other)" arc that
    # zooms to an empty disc). build_lazy keeps the full child set (no size floor)
    # on each side, then compare_subtree pairs them into a delta subtree.
    if path:
        base_full = load_full_tree_or_none(base_ts)
        cur_full = load_full_tree_or_none(cur_ts)
        base_sub = diff.find_node(base_full, path) if base_full is not None else None
        cur_sub = diff.find_node(cur_full, path) if cur_full is not None else None
        if base_sub is None and cur_sub is None:
            return {"base": base_ts, "cur": cur_ts, "lazy": True,
                    "error": "path not found in snapshot"}
        base_lazy = aggregate.build_lazy(base_sub) if base_sub is not None else None
        cur_lazy = aggregate.build_lazy(cur_sub) if cur_sub is not None else None
        out = {"base": base_ts, "cur": cur_ts, "lazy": True,
               "node": diff.compare_subtree(cur_lazy, base_lazy)}
        # If exactly one side's detail tree was unreadable (load returned None)
        # while the path resolved on the other, the drill can't tell a genuine
        # add/remove from a transient miss -- compare_subtree renders the whole
        # subtree wholly added/removed. Mark it provisional so main() serves it
        # no-cache rather than pinning that wrong diff for a day (mirrors the
        # overview's reconcile_degraded; both reach the same cache guard).
        if (base_full is None) != (cur_full is None):
            out["reconcile_degraded"] = True
        return out

    # The folded compare trees drive the directory-level diff; the full trees are
    # consulted lazily (only if a boundary crossing exists) to restate a folder
    # that grew/shrank across the fold floor -- otherwise it would read as a flat
    # added/removed even though the drill-in shows it partly pre-existed. A missing
    # full tree just degrades to the un-reconciled (old) classification rather than
    # failing the whole comparison, so reconciliation is best-effort.
    result = diff.compare(
        compare_tree(base_ts), compare_tree(cur_ts),
        base_full_loader=lambda: load_full_tree_or_none(base_ts),
        cur_full_loader=lambda: load_full_tree_or_none(cur_ts),
    )
    result["base"] = base_ts
    result["cur"] = cur_ts
    result["base_label"] = fmt.ts_label(base_ts)
    result["cur_label"] = fmt.ts_label(cur_ts)
    return result


# --------------------------------------------------------------------------
# dispatch
# --------------------------------------------------------------------------

def respond(body, cache="no-cache"):
    payload = json.dumps(body, separators=(",", ":"))
    sys.stdout.write("Content-Type: application/json; charset=utf-8\r\n")
    sys.stdout.write("Cache-Control: %s\r\n" % cache)
    sys.stdout.write("\r\n")
    sys.stdout.write(payload)


def main():
    qs = parse_qs(os.environ.get("QUERY_STRING", ""))
    op = (qs.get("op", [""])[0]) or ""
    ts = (qs.get("ts", [""])[0]) or ""
    path = (qs.get("path", [""])[0]) or ""
    base = (qs.get("base", [""])[0]) or ""
    cur = (qs.get("cur", [""])[0]) or ""

    # No real filesystem path exceeds PATH_MAX; reject oversized `path` values up
    # front so a multi-megabyte query string can't amplify the per-request tree
    # walk into a cheap DoS.
    if len(path) > 4096:
        respond({"error": "path not found"}, cache="no-cache")
        return

    try:
        if op == "snapshots":
            respond(op_snapshots())
        elif op == "status":
            respond(op_status())
        elif op == "stats":
            respond(op_stats(ts))
        elif op == "tree":
            # snapshots are immutable, so both the overview and lazy drill-down
            # responses are deterministic for a given (ts, path) -- let the
            # browser cache them and skip the gzip+aggregate cost on repeat.
            # exception: the "path not found" envelope is short-circuit cheap to
            # recompute and shouldn't pin a stale-client misstep into the browser
            # cache for a day, so respond no-cache on the error path.
            body = op_tree(ts, path)
            cache = "max-age=86400" if ts and "error" not in body else "no-cache"
            respond(body, cache=cache)
        elif op == "compare":
            # base/cur are immutable snapshots -> the diff is cacheable. The
            # "path not found" envelope is cheap to recompute and shouldn't pin a
            # stale-client misstep into the browser cache, so it stays no-cache
            # (mirrors op=tree). A reconcile_degraded diff (a full tree was
            # momentarily unreadable, so fold-boundary dirs stayed un-reconciled)
            # is provisional -- also no-cache, so the correct diff is recomputed
            # on the next request instead of being pinned for a day.
            body = op_compare(base, cur, path)
            cacheable = "error" not in body and not body.get("reconcile_degraded")
            cache = "max-age=86400" if cacheable else "no-cache"
            respond(body, cache=cache)
        else:
            respond({"error": "unknown op: %r" % op})
    except Exception:  # noqa: BLE001 - surface every failure as JSON
        # Keep the full traceback server-side; never echo str(exc) to the client
        # -- it leaks absolute data-dir paths and confirms snapshot existence.
        sys.stderr.write(traceback.format_exc())
        respond({"error": "internal error"})


if __name__ == "__main__":
    main()
