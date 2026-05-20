#!/bin/bash
# DUC Advanced -- periodic scan loop.
#
# Runs `duc index` on a schedule, samples the live process into a JSON-lines
# log, then freezes per-scan statistics and builds the aggregated directory
# tree. Everything is configured through environment variables so the scan
# targets are not baked into the image.
set -u

LIB="${DUC_LIB_DIR:-/app/lib}"
DB_DIR="${DUC_DB_DIR:-/var/lib/duc}"
SCAN_PATHS="${DUC_SCAN_PATHS:-/mnt/hdd-pool /mnt/ssd-pool}"
INTERVAL="${DUC_SCAN_INTERVAL:-86400}"
KEEP="${DUC_KEEP_SNAPSHOTS:-30}"

CURRENT_JSON="$DB_DIR/current-scan.json"
SAMPLES="$DB_DIR/current-scan.samples"
PROGRESS="$DB_DIR/progress.log"
INPROGRESS="$DB_DIR/in-progress.db"
LOG="$DB_DIR/scan-loop.log"

mkdir -p "$DB_DIR"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG" >&2; }

# Write `cmd` output to `dest` atomically; remove the temp file on failure.
generate() {
  local dest="$1"; shift
  if "$@" > "$dest.tmp" 2>>"$LOG"; then
    mv "$dest.tmp" "$dest"
  else
    rm -f "$dest.tmp"
    return 1
  fi
}

run_scan() {
  local ts start end rc final
  ts=$(date +%Y-%m-%d_%H-%M)
  start=$(date +%s)
  rm -f "$INPROGRESS" "$SAMPLES"
  : > "$PROGRESS"
  log "scan $ts starting: $SCAN_PATHS"

  # shellcheck disable=SC2086 -- SCAN_PATHS is an intentional word list.
  stdbuf -o0 -e0 duc index -H -p -d "$INPROGRESS" $SCAN_PATHS > "$PROGRESS" 2>&1 &
  local duc_pid=$!

  printf '{"ts":"%s","start":%s,"pid":%s,"paths":"%s","inprogress_db":"%s"}\n' \
    "$ts" "$start" "$duc_pid" "$SCAN_PATHS" "$INPROGRESS" > "$CURRENT_JSON"

  # Sample /proc until duc exits -- this blocks the loop for the whole scan.
  python3 "$LIB/sampler.py" "$duc_pid" "$SAMPLES" 8 || true
  wait "$duc_pid"; rc=$?
  end=$(date +%s)

  if [ "$rc" -eq 0 ] && [ -s "$INPROGRESS" ]; then
    final="$DB_DIR/duc-$ts.db"
    mv "$INPROGRESS" "$final"
    log "scan $ts finished in $((end - start))s -> $(basename "$final")"
    generate "$DB_DIR/duc-$ts.stats.json" \
      python3 "$LIB/scan_stats.py" "$final" "$start" "$end" "$SAMPLES" \
      || log "stats generation failed for $ts"
    generate "$DB_DIR/duc-$ts.tree.json" \
      python3 "$LIB/aggregate.py" "$final" \
      || log "tree generation failed for $ts"
  else
    log "scan $ts failed (rc=$rc) -- keeping previous snapshots"
  fi

  rm -f "$CURRENT_JSON" "$SAMPLES" "$INPROGRESS"
}

prune() {
  # Keep the newest $KEEP snapshots; drop older databases and their sidecars.
  local old base
  ls -1t "$DB_DIR"/duc-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    base="${old%.db}"
    rm -f "$old" "$base.stats.json" "$base.tree.json"
    log "pruned $(basename "$old")"
  done
}

log "scan loop started (interval=${INTERVAL}s, keep=${KEEP})"
while true; do
  run_scan
  prune
  sleep "$INTERVAL"
done
