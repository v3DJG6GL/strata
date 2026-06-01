#!/bin/bash
# Strata -- container entrypoint.
#
# Clears state from any ungraceful shutdown, then starts the scan loop
# (background) and the lighttpd web server (foreground, so it is the
# container's main process).
set -eu

DB_DIR="${STRATA_DB_DIR:-/var/lib/strata}"
APP_DIR="${STRATA_APP_DIR:-/app}"

mkdir -p "$DB_DIR"

# A scan interrupted by a container stop leaves transient files behind.
rm -f "$DB_DIR/current-scan.json" "$DB_DIR/current-scan.samples" || true
rm -f "$DB_DIR/next-scan.json" "$DB_DIR/progress.json" || true
rm -f "$DB_DIR"/strata-*.tmp 2>/dev/null || true

"$APP_DIR/scan-loop.sh" &

exec lighttpd -D -f /etc/lighttpd/lighttpd.conf
