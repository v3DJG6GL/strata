"""Thin interface to the `duc` binary.

Everything that shells out to `duc` lives here: version probing, the `duc info`
report parser, and opening a streaming `duc xml` pipe. Higher layers
(`aggregate.py`, `scan_stats.py`, `api.cgi`) build on these primitives.

duc 1.4.6 facts this module relies on (verified against the Debian package):
  * `duc xml`  emits  <duc root=.. size_apparent=.. size_actual=.. count=..>
                with nested <ent type="dir" name=.. size_apparent=.. .. count=..>;
                attributes are properly XML-escaped.
  * `duc json` is broken (stray commas -> invalid JSON), so XML is used instead.
  * `duc info` prints one whitespace-separated row per indexed root.
"""

import os
import re
import subprocess

DUC = os.environ.get("DUC_BIN", "duc")


def _run(args, timeout=None):
    """Run `duc <args>` and return stdout text. Raises on failure."""
    proc = subprocess.run(
        [DUC] + list(args),
        capture_output=True, text=True, timeout=timeout,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "duc %s failed (rc=%d): %s"
            % (" ".join(args), proc.returncode, (proc.stderr or proc.stdout).strip())
        )
    return proc.stdout


def duc_version():
    """Return the duc version string, e.g. "1.4.6" (or "unknown")."""
    try:
        out = _run(["--version"], timeout=10)
    except Exception:
        return "unknown"
    m = re.search(r"([0-9]+\.[0-9]+\.[0-9]+)", out)
    return m.group(1) if m else "unknown"


def _parse_info(text):
    """Parse `duc info` output into {path: {files, dirs, size, date}}."""
    rows = {}
    for line in text.splitlines():
        line = line.rstrip()
        if not line or line.startswith("Date"):
            continue
        # Date Time Files Dirs Size Path  -- Path is last and may contain spaces.
        parts = line.split(None, 5)
        if len(parts) < 6:
            continue
        date, time_, files, dirs, size, path = parts
        try:
            rows[path] = {
                "path": path,
                "date": date + " " + time_,
                "files": int(files),
                "dirs": int(dirs),
                "size": int(size),
            }
        except ValueError:
            continue
    return rows


def duc_info(db_path):
    """Return a list of per-root dicts for a database.

    Each dict: {path, date, files, dirs, size_actual, size_apparent}.
    Two `duc info` calls are made because each only reports one size kind.
    """
    actual = _parse_info(_run(["info", "-b", "-d", db_path], timeout=120))
    try:
        apparent = _parse_info(_run(["info", "-a", "-b", "-d", db_path], timeout=120))
    except Exception:
        apparent = {}
    roots = []
    for path, row in actual.items():
        ap = apparent.get(path, {})
        roots.append({
            "path": path,
            "date": row["date"],
            "files": row["files"],
            "dirs": row["dirs"],
            "size_actual": row["size"],
            "size_apparent": ap.get("size", row["size"]),
        })
    # Stable order: largest first.
    roots.sort(key=lambda r: r["size_actual"], reverse=True)
    return roots


def open_duc_xml(db_path, path):
    """Start `duc xml -x` for one path and return the Popen.

    `-x` excludes individual files, so only directories are streamed -- exactly
    what the sunburst needs. The caller iter-parses proc.stdout, then must call
    finish_duc_xml(proc).
    """
    return subprocess.Popen(
        [DUC, "xml", "-x", "-d", db_path, path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )


def finish_duc_xml(proc):
    """Reap a duc xml process; raise if it failed."""
    err = b""
    try:
        if proc.stderr is not None:
            err = proc.stderr.read()
    except Exception:
        pass
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError("duc xml failed (rc=%d): %s" % (rc, err.decode("utf-8", "replace").strip()))


def human_duration(seconds):
    """Format a duration like "1h 02m", "3m 12s", "45s"."""
    if seconds is None:
        return None
    seconds = int(seconds)
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm %02ds" % (seconds // 60, seconds % 60)
    return "%dh %02dm" % (seconds // 3600, (seconds % 3600) // 60)


def ts_label(ts):
    """Turn a snapshot id "2026-05-20_22-12" into the label "2026-05-20 22:12"."""
    parts = ts.split("_", 1)
    if len(parts) == 2:
        return parts[0] + " " + parts[1].replace("-", ":")
    return ts
