#!/bin/bash
# Strata -- periodic scan loop.
#
# Runs the inode-aware indexer on a schedule, samples the live process into a
# JSON-lines log, then freezes per-scan statistics. All configuration comes
# from environment variables.
set -u

LIB="${STRATA_LIB_DIR:-/app/lib}"
DB_DIR="${STRATA_DB_DIR:-/var/lib/strata}"
INTERVAL="${STRATA_SCAN_INTERVAL:-86400}"
KEEP="${STRATA_KEEP_SNAPSHOTS:-30}"
SCAN_ON_START="${STRATA_SCAN_ON_START:-}"
SCHEDULE="${STRATA_SCAN_SCHEDULE:-}"
TZ_NAME="${TZ:-UTC}"

CURRENT_JSON="$DB_DIR/current-scan.json"
SAMPLES="$DB_DIR/current-scan.samples"
PROGRESS="$DB_DIR/progress.log"
NEXT_JSON="$DB_DIR/next-scan.json"
LOG="$DB_DIR/scan-loop.log"

mkdir -p "$DB_DIR"

log() { echo "[$(date -Is)] $*" | tee -a "$LOG" >&2; }

# Truthy for 1/true/yes/on (case-insensitive); false for anything else,
# including unset, empty or unrecognised values.
is_true() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes | on) return 0 ;;
    *) return 1 ;;
  esac
}

run_scan() {
  local ts start end rc
  ts=$(date +%Y-%m-%d_%H-%M)
  start=$(date +%s)
  rm -f "$SAMPLES"
  # Drop any stale progress from the previous scan. The indexer publishes a
  # fresh 'counting' doc as its first action, so op_status reads valid JSON
  # almost immediately; an absent file in the meantime is handled gracefully.
  rm -f "$PROGRESS" "$PROGRESS.tmp"
  log "scan $ts starting: ${STRATA_SCAN_PATHS:-(unset)}"

  python3 "$LIB/indexer.py" --ts "$ts" --out "$DB_DIR" --progress "$PROGRESS" \
    >>"$LOG" 2>&1 &
  local pid=$!

  # Build via json.dumps, not printf: STRATA_SCAN_PATHS is admin-supplied and a
  # quote/backslash/control char would otherwise produce malformed JSON, making
  # op_status fail to parse and report scanning:false for the whole live scan.
  # Values pass through the environment so they're never interpreted as code.
  TS="$ts" START="$start" PID="$pid" PATHS="${STRATA_SCAN_PATHS:-}" python3 -c '
import json, os
print(json.dumps({
    "ts": os.environ["TS"],
    "start": int(os.environ["START"]),
    "pid": int(os.environ["PID"]),
    "paths": os.environ["PATHS"],
}))' > "$CURRENT_JSON"

  # Sample /proc until the indexer exits -- this blocks for the whole scan.
  python3 "$LIB/sampler.py" "$pid" "$SAMPLES" 8 || true
  wait "$pid"; rc=$?
  end=$(date +%s)

  if [ "$rc" -eq 0 ] && [ -f "$DB_DIR/strata-$ts.tree.json" ]; then
    log "scan $ts finished in $((end - start))s"
    if python3 "$LIB/scan_stats.py" "$DB_DIR/strata-$ts.totals.json" \
         "$start" "$end" "$SAMPLES" > "$DB_DIR/strata-$ts.stats.json.tmp" 2>>"$LOG"; then
      mv "$DB_DIR/strata-$ts.stats.json.tmp" "$DB_DIR/strata-$ts.stats.json"
    else
      rm -f "$DB_DIR/strata-$ts.stats.json.tmp"
      log "stats generation failed for $ts"
    fi
  else
    log "scan $ts failed (rc=$rc) -- discarding partial artifacts"
    # Guard the glob: if $ts ever ended up empty (date failure under set -u),
    # `strata-.*` would match every snapshot in the directory.
    [ -n "$ts" ] && rm -f "$DB_DIR/strata-$ts".*
  fi

  rm -f "$CURRENT_JSON" "$SAMPLES"
}

prune() {
  # Keep the newest $KEEP snapshots; drop older ones and their sidecars.
  local old base
  ls -1t "$DB_DIR"/strata-*.tree.json 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    base="${old%.tree.json}"
    rm -f "$base".tree.json "$base".full.json.gz "$base".stats.json "$base".totals.json
    log "pruned $(basename "$base")"
  done
}

# Publish next-scan.json (atomically) so the API/UI can count down to the next
# scan. Built via json.dumps with values passed through the environment, never
# interpreted as code -- the schedule string is admin-supplied.
write_next_scan() {  # $1 = epoch the next scan is due
  local sched=""
  [ "$MODE" = schedule ] && sched="$SCHEDULE"
  NEXT="$1" M="$MODE" SCHED="$sched" IVL="$INTERVAL" TZN="$TZ_NAME" OUT="$NEXT_JSON" \
  python3 -c '
import json, os
tmp = os.environ["OUT"] + ".tmp"
with open(tmp, "w") as f:
    json.dump({
        "next": int(os.environ["NEXT"]),
        "mode": os.environ["M"],
        "schedule": os.environ["SCHED"] or None,
        "interval_sec": int(os.environ["IVL"]),
        "tz": os.environ["TZN"],
    }, f)
os.replace(tmp, os.environ["OUT"])
' 2>>"$LOG" || true
}

# Epoch of the next scan.
#   schedule mode -> next cron match after now (missed times are skipped,
#                    standard cron semantics)
#   interval mode -> a fixed point INTERVAL after the iteration start ($1),
#                    preserving the historical start-to-start cadence.
next_scan_epoch() {  # $1 = iteration start epoch (interval anchor)
  if [ "$MODE" = schedule ]; then
    python3 "$LIB/schedule.py" next "$SCHEDULE" --after "$(date +%s)" --tz "$TZ_NAME" 2>>"$LOG"
  else
    echo $(( $1 + INTERVAL ))
  fi
}

# Mode selection: a schedule expression takes precedence over the interval; an
# invalid one logs and falls back to the interval so a typo can't stop scanning.
MODE="interval"
if [ -n "$SCHEDULE" ]; then
  if python3 "$LIB/schedule.py" validate "$SCHEDULE" 2>>"$LOG"; then
    MODE="schedule"
  else
    log "STRATA_SCAN_SCHEDULE='$SCHEDULE' is invalid -- falling back to interval=${INTERVAL}s"
  fi
fi

if [ "$MODE" = schedule ]; then
  log "scan loop started (schedule='$SCHEDULE' tz=$TZ_NAME, keep=$KEEP)"
else
  log "scan loop started (interval=${INTERVAL}s, keep=$KEEP)"
fi

# Decide the FIRST target epoch.
#   - STRATA_SCAN_ON_START forces an immediate scan (testing/dev).
#   - A first-ever deploy (no snapshots) scans straight away so the UI isn't
#     empty until the first scheduled time.
#   - schedule mode otherwise waits for the next cron match.
#   - interval mode otherwise honours the recent-snapshot deferral across
#     restarts (the sleep countdown lives only in this process, so without it a
#     redeploy would rescan regardless of how recently one ran).
now=$(date +%s)
newest=$(ls -1t "$DB_DIR"/strata-*.tree.json 2>/dev/null | head -n1)
if is_true "$SCAN_ON_START"; then
  target="$now"
  log "STRATA_SCAN_ON_START is set -- scanning immediately on container start"
elif [ -z "$newest" ]; then
  target="$now"
  log "no snapshots yet -- scanning immediately"
elif [ "$MODE" = schedule ]; then
  target=$(next_scan_epoch "$now"); [ -z "$target" ] && target="$now"
  log "schedule mode: first scan at $(date -d "@$target" -Is 2>/dev/null || echo "@$target")"
else
  age=$(( now - $(stat -c %Y "$newest") ))
  [ "$age" -lt 0 ] && age=0
  if [ "$age" -lt "$INTERVAL" ]; then
    target=$(( now + INTERVAL - age ))
    log "newest snapshot is ${age}s old; deferring first scan $(( INTERVAL - age ))s"
  else
    target="$now"
    log "newest snapshot is ${age}s old (>= interval); scanning now"
  fi
fi

while true; do
  write_next_scan "$target"
  sleep_for=$(( target - $(date +%s) ))
  [ "$sleep_for" -gt 0 ] && sleep "$sleep_for"

  iter_start=$(date +%s)
  run_scan
  prune

  if [ "$MODE" = schedule ]; then
    target=$(next_scan_epoch "$iter_start")
    # If the helper failed mid-run, don't busy-loop: fall back to interval.
    [ -z "$target" ] && target=$(( iter_start + INTERVAL ))
  else
    target=$(( iter_start + INTERVAL ))
  fi
done
