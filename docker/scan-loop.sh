#!/bin/bash
# DUC Advanced -- periodic scan loop.
#
# Runs the inode-aware indexer on a schedule, samples the live process into a
# JSON-lines log, then freezes per-scan statistics. All configuration comes
# from environment variables.
set -u

LIB="${DUC_LIB_DIR:-/app/lib}"
DB_DIR="${DUC_DB_DIR:-/var/lib/duc}"
INTERVAL="${DUC_SCAN_INTERVAL:-86400}"
KEEP="${DUC_KEEP_SNAPSHOTS:-30}"

CURRENT_JSON="$DB_DIR/current-scan.json"
SAMPLES="$DB_DIR/current-scan.samples"
PROGRESS="$DB_DIR/progress.log"
LOG="$DB_DIR/scan-loop.log"

mkdir -p "$DB_DIR"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG" >&2; }

run_scan() {
  local ts start end rc
  ts=$(date +%Y-%m-%d_%H-%M)
  start=$(date +%s)
  rm -f "$SAMPLES"
  : > "$PROGRESS"
  log "scan $ts starting: ${DUC_SCAN_PATHS:-(unset)}"

  python3 "$LIB/indexer.py" --ts "$ts" --out "$DB_DIR" --progress "$PROGRESS" \
    >>"$LOG" 2>&1 &
  local pid=$!

  printf '{"ts":"%s","start":%s,"pid":%s,"paths":"%s"}\n' \
    "$ts" "$start" "$pid" "${DUC_SCAN_PATHS:-}" > "$CURRENT_JSON"

  # Sample /proc until the indexer exits -- this blocks for the whole scan.
  python3 "$LIB/sampler.py" "$pid" "$SAMPLES" 8 || true
  wait "$pid"; rc=$?
  end=$(date +%s)

  if [ "$rc" -eq 0 ] && [ -f "$DB_DIR/duc-$ts.tree.json" ]; then
    log "scan $ts finished in $((end - start))s"
    if python3 "$LIB/scan_stats.py" "$DB_DIR/duc-$ts.totals.json" \
         "$start" "$end" "$SAMPLES" > "$DB_DIR/duc-$ts.stats.json.tmp" 2>>"$LOG"; then
      mv "$DB_DIR/duc-$ts.stats.json.tmp" "$DB_DIR/duc-$ts.stats.json"
    else
      rm -f "$DB_DIR/duc-$ts.stats.json.tmp"
      log "stats generation failed for $ts"
    fi
  else
    log "scan $ts failed (rc=$rc) -- discarding partial artifacts"
    rm -f "$DB_DIR/duc-$ts".*
  fi

  rm -f "$CURRENT_JSON" "$SAMPLES"
}

prune() {
  # Keep the newest $KEEP snapshots; drop older ones and their sidecars.
  local old base
  ls -1t "$DB_DIR"/duc-*.tree.json 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    base="${old%.tree.json}"
    rm -f "$base".tree.json "$base".full.json.gz "$base".stats.json "$base".totals.json
    log "pruned $(basename "$base")"
  done
}

log "scan loop started (interval=${INTERVAL}s, keep=${KEEP})"
while true; do
  run_scan
  prune
  sleep "$INTERVAL"
done
