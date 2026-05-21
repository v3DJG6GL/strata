# DUC Advanced

An interactive disk-usage visualizer built on top of [`duc`](https://duc.zevv.nl).

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
| `DUC_SCAN_PATHS`        | `/mnt/hdd-pool /mnt/ssd-pool`  | Space-separated directories to scan. |
| `DUC_SCAN_INTERVAL`     | `86400`                        | Seconds between scans. |
| `DUC_KEEP_SNAPSHOTS`    | `30`                           | Number of snapshots to retain. |
| `DUC_SCAN_ON_START`     | *(none)*                       | Testing/dev. If truthy (`1`/`true`/`yes`/`on`), run a scan on every container start, overriding the recent-snapshot deferral. |
| `DUC_HARDLINK_PRIORITY` | *(none)*                       | Directories whose hard links are preferred as the counted "original" — one directory per line. |
| `DUC_HARDLINK_COPIES`   | *(none)*                       | Directories whose hard links are ranked last and treated as copies — one directory per line. |

Each path in `DUC_SCAN_PATHS` must be inside a volume mounted into the
container (the default compose file mounts `/mnt` read-only).

**Hardlink attribution.** A file with several hard links is counted once. The
directory that "owns" it is chosen in this order: a link inside a
`DUC_HARDLINK_PRIORITY` directory, then a link in an unlisted directory, then
a link inside a `DUC_HARDLINK_COPIES` directory. Every other link is reported
as a copy.

### Volumes

- `/mnt:/mnt:ro` — read-only access to the data being measured.
- `<host path>:/var/lib/duc` — persistent storage for snapshot databases
  (`duc-<ts>.db`) and the generated `*.stats.json` / `*.tree.json` sidecars.

## Build locally

```sh
docker compose build      # uncomment `build: .` in docker-compose.yaml first
# or
docker build -t duc-advanced .
```

Pushes to `main` and version tags build and publish
`ghcr.io/<owner>/duc-advanced` via GitHub Actions (`.github/workflows/build.yml`).

## How it works

```
docker/scan-loop.sh   periodic `duc index` + live /proc sampling
lib/sampler.py        samples a running scan into a JSON-lines log
lib/scan_stats.py     freezes per-scan stats into duc-<ts>.stats.json
lib/duc_export.py     thin wrapper around the duc binary
lib/aggregate.py      streams `duc xml` into a bounded, aggregated tree
cgi/api.cgi           JSON API (snapshots, status, stats, tree)
web/                  the single-page app (vanilla JS + vendored D3 v7)
```

`duc` itself keeps no scan history and its built-in CGI re-renders the whole
page on every click; DUC Advanced replaces that with snapshot databases plus a
client-side interactive UI fed by a small JSON API.
