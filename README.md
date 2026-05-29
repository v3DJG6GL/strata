# Strata

An interactive, self-hosted disk-usage visualizer.

It periodically indexes one or more directory trees, keeps a rolling history of
snapshots, and serves a single-page web UI with:

- **An interactive zoomable sunburst** — smooth in-place drill-down (no page
  reloads), tooltips on *every* slice including tiny ones, a breadcrumb trail
  and a details side panel. Large filesystems are pre-aggregated for an instant
  first paint and finer detail is lazy-loaded on demand.
- **Per-scan statistics** — every snapshot keeps a frozen telemetry panel
  (duration, file/dir counts, sizes, I/O totals, throughput) that stays visible
  long after the scan finishes, plus a live panel while a scan is running.

> Comparison of two scans (delta-colored sunburst + diff table) is planned as a
> follow-up phase.

## Deploy

The application ships as a container image on GHCR. Edit `docker-compose.yaml`
and run:

```sh
docker compose up -d
```

Then open `http://<host>:8000/`.

### Configuration

All scan configuration lives in environment variables — nothing is baked into
the image:

| Variable                | Default                       | Meaning |
|-------------------------|-------------------------------|---------|
| `STRATA_SCAN_PATHS`        | `/mnt/hdd-pool /mnt/ssd-pool`  | Space-separated directories to scan. |
| `STRATA_SCAN_INTERVAL`     | `86400`                        | Seconds between scans (start-to-start). Used when no schedule is set, and as the fallback if a schedule is invalid. |
| `STRATA_SCAN_SCHEDULE`     | *(none)*                       | A 5-field cron expression (`min hour day-of-month month day-of-week`). When set, it overrides `STRATA_SCAN_INTERVAL` and scans fire at these wall-clock times (DST-aware, honoring `TZ`). Numeric fields only; supports `*`, lists, ranges and `*/n` steps; standard cron day-of-month/day-of-week OR-semantics. Example: `0 20 * * *` = daily at 20:00. An invalid expression logs a warning and falls back to the interval. |
| `TZ`                       | `UTC`                          | IANA timezone (e.g. `Europe/Zurich`) used for the schedule and for log/snapshot timestamps. The image bundles `tzdata`. |
| `STRATA_KEEP_SNAPSHOTS`    | `30`                           | Number of snapshots to retain. |
| `STRATA_SCAN_ON_START`     | *(none)*                       | Testing/dev. If truthy (`1`/`true`/`yes`/`on`), run a scan on every container start, overriding the schedule/deferral. |
| `STRATA_HARDLINK_PRIORITY` | *(none)*                       | Directories whose hard links are preferred as the counted "original" — one directory per line. |
| `STRATA_HARDLINK_COPIES`   | *(none)*                       | Directories whose hard links are ranked last and treated as copies — one directory per line. |

When `STRATA_SCAN_SCHEDULE` is set, the first scan after a fresh deploy still
runs immediately (so the UI isn't empty until the first scheduled time);
thereafter scans fire only at the scheduled times. A missed time (container
down, or a previous scan still running) is skipped rather than caught up.

Each path in `STRATA_SCAN_PATHS` must be inside a volume mounted into the
container (the default compose file mounts `/mnt` read-only).

**Hardlink attribution.** A file with several hard links is counted once. The
directory that "owns" it is chosen in this order: a link inside a
`STRATA_HARDLINK_PRIORITY` directory, then a link in an unlisted directory, then
a link inside a `STRATA_HARDLINK_COPIES` directory. Every other link is reported
as a copy.

### Volumes

- `/mnt:/mnt:ro` — read-only access to the data being measured.
- `<host path>:/var/lib/strata` — persistent storage for the generated
  snapshot artifacts (`strata-<ts>.tree.json` and its sidecars).

## Build locally

```sh
docker compose build      # uncomment `build: .` in docker-compose.yaml first
# or
docker build -t strata .
```

Pushes to `main` and version tags build and publish
`ghcr.io/<owner>/strata` via GitHub Actions (`.github/workflows/build.yml`).

## How it works

```
docker/scan-loop.sh   periodic indexer runs + live /proc sampling
lib/sampler.py        samples a running scan into a JSON-lines log
lib/scan_stats.py     freezes per-scan stats into strata-<ts>.stats.json
lib/textfmt.py        shared text/format helpers
lib/aggregate.py      folds the detail tree into a bounded overview
cgi/api.cgi           JSON API (snapshots, status, stats, tree)
web/                  the single-page app (vanilla JS + vendored D3 v7)
```

Each scan is frozen as a set of JSON artifacts; the web UI is fully
client-side and reads them through a small JSON API, so drilling into the
sunburst and switching snapshots never reloads the page.
