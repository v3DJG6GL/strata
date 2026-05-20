"""Capture per-scan statistics into a `duc-<ts>.stats.json` sidecar.

This is what makes a finished scan's telemetry survive: duc itself keeps no
scan history and the live progress log is truncated at the next scan, so the
numbers are frozen here the moment a scan completes.

Two modes:
  * full      python3 scan_stats.py <db> <start_epoch> <end_epoch> <samples>
              -- called by scan-loop.sh right after a scan; records duration,
                 I/O totals (from the last sampler reading) and derived rates.
  * backfill  python3 scan_stats.py <db>
              -- called for pre-existing databases; duration/I/O are unknown
                 and emitted as null.
"""

import json
import os
import sys

import duc_export as duc


def _ts_from_db(db_path):
    """Extract the snapshot id from a `.../duc-<ts>.db` path."""
    base = os.path.basename(db_path)
    if base.startswith("duc-") and base.endswith(".db"):
        return base[4:-3]
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


def build_stats(db_path, start=None, end=None, samples_path=None):
    ts = _ts_from_db(db_path)
    roots = duc.duc_info(db_path)

    total = {
        "files": sum(r["files"] for r in roots),
        "dirs": sum(r["dirs"] for r in roots),
        "size_actual": sum(r["size_actual"] for r in roots),
        "size_apparent": sum(r["size_apparent"] for r in roots),
    }

    try:
        db_bytes = os.path.getsize(db_path)
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
            "files_per_sec": round(total["files"] / duration, 1),
            "db_growth_kib_s": round(db_bytes / duration / 1024, 1) if db_bytes else None,
        }

    return {
        "ts": ts,
        "label": duc.ts_label(ts),
        "duc_version": duc.duc_version(),
        "start": start,
        "end": end,
        "duration_sec": duration,
        "duration_human": duc.human_duration(duration),
        "roots": roots,
        "total": total,
        "db_bytes": db_bytes,
        "io": io,
        "rates": rates,
    }


def main(argv):
    if len(argv) < 2:
        sys.stderr.write("usage: scan_stats.py <db> [<start> <end> <samples>]\n")
        return 2
    db_path = argv[1]
    start = end = samples = None
    if len(argv) >= 4:
        try:
            start = int(float(argv[2]))
            end = int(float(argv[3]))
        except ValueError:
            start = end = None
    if len(argv) >= 5:
        samples = argv[4]
    stats = build_stats(db_path, start, end, samples)
    json.dump(stats, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
