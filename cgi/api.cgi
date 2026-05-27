#!/usr/bin/env python3
"""JSON API for Strata (CGI, served by lighttpd).

Endpoints (GET cgi-bin/api.cgi?op=...):
  op=snapshots                 -> list of scans + summary stats
  op=status                    -> live scan progress (or {"scanning":false})
  op=stats&ts=<ts>             -> frozen per-scan stats
  op=tree&ts=<ts>              -> pre-built aggregated directory tree
  op=tree&ts=<ts>&path=<abs>   -> lazily aggregated subtree for a drill-down

Every response is application/json; errors are returned as {"error": "..."}
with HTTP 200 so the frontend can handle them uniformly.
"""

import gzip
import json
import os
import re
import sys
import traceback

sys.path.insert(0, os.environ.get("STRATA_LIB_DIR", "/app/lib"))

from urllib.parse import parse_qs

import textfmt as fmt
import aggregate
import scan_stats
import diff

DB_DIR = os.environ.get("STRATA_DB_DIR", "/var/lib/strata")
CURRENT_JSON = os.path.join(DB_DIR, "current-scan.json")
SAMPLES = os.path.join(DB_DIR, "current-scan.samples")
PROGRESS = os.path.join(DB_DIR, "progress.log")

TS_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}$")
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


def find_node(node, path):
    """Locate the node at absolute `path` within a tree, or None.

    (other) buckets inherit their parent's path (see aggregate.py); skip them
    explicitly so the lookup is invariant under children-iteration order.
    Iterative so a deeply-nested filesystem won't blow the recursion limit."""
    cur = node
    while True:
        if not cur.get("other") and (cur.get("path") or "") == path:
            return cur
        nxt = None
        for c in cur.get("children", []):
            if c.get("other"):
                continue
            cp = c.get("path") or ""
            if cp == path or path.startswith(cp + "/"):
                nxt = c
                break
        if nxt is None:
            return None
        cur = nxt


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


def humansize_count(text):
    """Parse a progress count like "1.2M" into an integer (1000-base)."""
    m = re.match(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([KMGT]?)", text or "", re.I)
    if not m:
        return None
    mult = {"": 1, "K": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}[m.group(2).upper()]
    return int(float(m.group(1)) * mult)


def parse_progress():
    """Extract (files, dirs, current_path) from the live progress log."""
    try:
        with open(PROGRESS, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - 8192))
            tail = f.read().decode("utf-8", "replace")
    except OSError:
        return None, None, None
    tail = tail.replace("\r", "\n")
    files_h = dirs_h = cur_path = None
    for line in tail.splitlines():
        stripped = line.strip()
        if stripped.startswith("At: "):
            cur_path = stripped[4:] or None
            continue
        if "file" not in line or "director" not in line:
            continue
        fm = re.search(r"([0-9]+(?:\.[0-9]+)?\s*[KMGT]?)\s*files", line, re.I)
        dm = re.search(r"([0-9]+(?:\.[0-9]+)?\s*[KMGT]?)\s*director", line, re.I)
        if fm:
            files_h = fm.group(1).replace(" ", "")
        if dm:
            dirs_h = dm.group(1).replace(" ", "")
    return files_h, dirs_h, cur_path


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
    try:
        with open(CURRENT_JSON) as f:
            cur = json.load(f)
    except (OSError, ValueError):
        return {"scanning": False}

    import time
    now = time.time()
    start = cur.get("start")
    elapsed = int(now - start) if start else None

    res = {
        "scanning": True,
        "ts": cur.get("ts"),
        "pid": cur.get("pid"),
        "paths": cur.get("paths"),
        "elapsed_sec": elapsed,
        "current_path": None, "depth": None,
        "files": None, "dirs": None, "files_human": None, "dirs_human": None,
        "cpu_pct": None, "mem_mb": None, "cmem_mb": None, "status_desc": None,
        "read_bytes": None, "write_bytes": None, "read_rate": None, "write_rate": None,
        "db_bytes": None, "db_growth_rate": None,
    }

    files_h, dirs_h, cur_path = parse_progress()
    res["files_human"], res["dirs_human"] = files_h, dirs_h
    res["files"] = humansize_count(files_h)
    res["dirs"] = humansize_count(dirs_h)
    if cur_path:
        res["current_path"] = cur_path
        res["depth"] = max(0, cur_path.count("/"))

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


def op_tree(ts, path):
    if path:
        sub = find_node(load_full_tree(ts), path)
        if sub is None:
            return {"ts": ts, "lazy": True, "error": "path not found in snapshot"}
        return {"ts": ts, "lazy": True, "node": aggregate.build_lazy(sub)}
    return {"ts": ts, "lazy": False, "node": overview_tree(ts)}


def op_compare(base_ts, cur_ts):
    result = diff.compare(overview_tree(base_ts), overview_tree(cur_ts))
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

    try:
        if op == "snapshots":
            respond(op_snapshots())
        elif op == "status":
            respond(op_status())
        elif op == "stats":
            respond(op_stats(ts))
        elif op == "tree":
            # an immutable snapshot tree may be cached by the browser
            cache = "max-age=86400" if (ts and not path) else "no-cache"
            respond(op_tree(ts, path), cache=cache)
        elif op == "compare":
            # base/cur are immutable snapshots -> the diff is cacheable
            respond(op_compare(base, cur), cache="max-age=86400")
        else:
            respond({"error": "unknown op: %r" % op})
    except Exception as exc:  # noqa: BLE001 - surface every failure as JSON
        sys.stderr.write(traceback.format_exc())
        respond({"error": str(exc)})


if __name__ == "__main__":
    main()
