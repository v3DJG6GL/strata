"""Sample a running `duc index` process into a JSON-lines log.

duc only exposes scan progress through a log it overwrites; CPU, memory, I/O
and the current directory have to be read from /proc while the process runs.
This sampler is launched by scan-loop.sh for the lifetime of one scan: it
appends one JSON object per interval to a samples file. The API's `op=status`
endpoint reads the tail for live progress, and `scan_stats.py` reads the final
line to freeze the scan's I/O totals.

    python3 sampler.py <pid> <out-file> [interval-seconds]

Exits cleanly once the target process is gone.
"""

import json
import os
import sys
import time


def read_sample(pid):
    """Read one /proc snapshot for `pid`, or None once the process is gone."""
    s = {"t": time.time()}
    try:
        with open("/proc/%d/io" % pid) as f:
            for line in f:
                key, _, val = line.partition(":")
                if key in ("read_bytes", "write_bytes"):
                    s[key] = int(val)
    except OSError:
        return None  # process has exited

    try:
        with open("/proc/%d/stat" % pid) as f:
            fields = f.read().rsplit(")", 1)[-1].split()
        # After "comm)" : field[0]=state, then ... utime=13, stime=14 (0-based
        # from the original numbering); here offset by the 2 leading fields.
        s["state"] = fields[0]
        s["utime"] = int(fields[11])
        s["stime"] = int(fields[12])
    except (OSError, IndexError, ValueError):
        pass

    try:
        with open("/proc/%d/status" % pid) as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    s["rss_kb"] = int(line.split()[1])
                    break
    except (OSError, IndexError, ValueError):
        pass

    try:
        s["cwd"] = os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        pass

    for path in ("/sys/fs/cgroup/memory.current",
                 "/sys/fs/cgroup/memory/memory.usage_in_bytes"):
        try:
            with open(path) as f:
                s["cmem_bytes"] = int(f.read().strip())
            break
        except (OSError, ValueError):
            continue

    return s


def main(argv):
    if len(argv) < 3:
        sys.stderr.write("usage: sampler.py <pid> <out-file> [interval]\n")
        return 2
    pid = int(argv[1])
    out_path = argv[2]
    interval = float(argv[3]) if len(argv) > 3 else 8.0

    while True:
        sample = read_sample(pid)
        if sample is None:
            break
        try:
            with open(out_path, "a") as f:
                f.write(json.dumps(sample, separators=(",", ":")) + "\n")
        except OSError:
            pass
        time.sleep(interval)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
