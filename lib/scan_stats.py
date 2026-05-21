"""Freeze per-scan statistics into a `strata-<ts>.stats.json` sidecar.

Reads the totals written by indexer.py, plus the scan's wall-clock timing and
the final sampler reading, and writes the stats the dashboard and scan page
display.

    python3 scan_stats.py <totals.json> [<start_epoch> <end_epoch> <samples>]
"""

import json
import os
import sys

import textfmt as fmt  # human_duration, ts_label


def _ts_from(path):
    """Extract the snapshot id from a `.../strata-<ts>.totals.json` path."""
    base = os.path.basename(path)
    if base.startswith("strata-"):
        for suffix in (".totals.json", ".stats.json"):
            if base.endswith(suffix):
                return base[len("strata-"):-len(suffix)]
    return base


def _last_sample(samples_path):
    """Return the final sampler reading, or {} if unavailable."""
    if not samples_path or not os.path.exists(samples_path):
        return {}
    last = ""
    try:
        with open(samples_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    last = line
    except OSError:
        return {}
    if not last:
        return {}
    try:
        return json.loads(last)
    except ValueError:
        return {}


def build_stats(totals_path, start=None, end=None, samples_path=None):
    ts = _ts_from(totals_path)
    with open(totals_path) as f:
        totals = json.load(f)
    roots = totals.get("roots", [])
    total = totals.get("total", {})

    db_dir = os.path.dirname(os.path.abspath(totals_path))
    try:
        db_bytes = os.path.getsize(os.path.join(db_dir, "strata-%s.full.json.gz" % ts))
    except OSError:
        db_bytes = None

    duration = None
    if start is not None and end is not None and end >= start:
        duration = int(end - start)

    sample = _last_sample(samples_path)
    io = None
    if "read_bytes" in sample or "write_bytes" in sample:
        io = {
            "read_bytes": sample.get("read_bytes"),
            "write_bytes": sample.get("write_bytes"),
        }

    rates = None
    if duration and duration > 0:
        rates = {
            "files_per_sec": round((total.get("files") or 0) / duration, 1),
            "db_growth_kib_s": round(db_bytes / duration / 1024, 1) if db_bytes else None,
        }

    return {
        "ts": ts,
        "label": fmt.ts_label(ts),
        "indexer": "built-in inode-aware indexer",
        "start": start,
        "end": end,
        "duration_sec": duration,
        "duration_human": fmt.human_duration(duration),
        "roots": roots,
        "total": total,
        "db_bytes": db_bytes,
        "io": io,
        "rates": rates,
    }


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: scan_stats.py <totals.json> [<start> <end> <samples>]\n")
        return 2
    totals_path = argv[1]
    start = end = samples = None
    if len(argv) >= 4:
        try:
            start = int(float(argv[2]))
            end = int(float(argv[3]))
        except ValueError:
            start = end = None
    if len(argv) >= 5:
        samples = argv[4]
    json.dump(build_stats(totals_path, start, end, samples), sys.stdout,
              separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
