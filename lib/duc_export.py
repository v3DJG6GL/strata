"""Shared text/format helpers.

(Historically this module wrapped the `duc` binary; since DUC Advanced gained
its own inode-aware indexer it only holds these small formatters. The module
name is kept to avoid churn — imported as `duc_export` by scan_stats / api.cgi.)
"""


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
