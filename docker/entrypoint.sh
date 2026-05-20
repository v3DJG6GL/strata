#!/bin/bash
# DUC Advanced -- container entrypoint.
#
# Cleans up after any ungraceful shutdown, backfills metadata for snapshots
# that pre-date this image, then starts the scan loop (background) and the
# lighttpd web server (foreground, so it becomes PID 1's main process).
set -eu

LIB="${DUC_LIB_DIR:-/app/lib}"
DB_DIR="${DUC_DB_DIR:-/var/lib/duc}"
APP_DIR="${DUC_APP_DIR:-/app}"

mkdir -p "$DB_DIR"

# A scan that was interrupted by a container stop leaves stale state behind.
rm -f "$DB_DIR/in-progress.db" "$DB_DIR/current-scan.json" "$DB_DIR/current-scan.samples"

# Backfill per-scan stats for databases created before this image (or by an
# older version). This only runs `duc info`, so it is fast even for many DBs.
for db in "$DB_DIR"/duc-*.db; do
  [ -e "$db" ] || continue
  base="${db%.db}"
  if [ ! -f "$base.stats.json" ]; then
    if python3 "$LIB/scan_stats.py" "$db" > "$base.stats.json.tmp" 2>/dev/null; then
      mv "$base.stats.json.tmp" "$base.stats.json"
    else
      rm -f "$base.stats.json.tmp"
    fi
  fi
done

# Pre-build the aggregated tree for the newest snapshot in the background so
# the results view opens instantly; older trees are built lazily on demand.
newest=$(ls -1t "$DB_DIR"/duc-*.db 2>/dev/null | head -1 || true)
if [ -n "${newest:-}" ]; then
  base="${newest%.db}"
  if [ ! -f "$base.tree.json" ]; then
    (
      if python3 "$LIB/aggregate.py" "$newest" > "$base.tree.json.tmp" 2>/dev/null; then
        mv "$base.tree.json.tmp" "$base.tree.json"
      else
        rm -f "$base.tree.json.tmp"
      fi
    ) &
  fi
fi

"$APP_DIR/scan-loop.sh" &

exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
