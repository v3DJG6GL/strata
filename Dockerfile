# Strata -- interactive disk-usage visualizer.
FROM debian:trixie-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends lighttpd python3 tzdata; \
    rm -rf /var/lib/apt/lists/*

# Backend: the inode-aware indexer, helpers and shell scripts.
COPY lib/                       /app/lib/
COPY docker/scan-loop.sh        /app/scan-loop.sh
COPY docker/entrypoint.sh       /app/entrypoint.sh
COPY docker/lighttpd.conf       /etc/lighttpd/lighttpd.conf

# Frontend: the static SPA (D3 is vendored under web/vendor) and the CGI API.
COPY web/                       /var/www/html/
COPY cgi/                       /var/www/html/cgi-bin/

RUN chmod +x /app/entrypoint.sh /app/scan-loop.sh /var/www/html/cgi-bin/api.cgi

# Defaults -- override these in docker-compose to change what gets scanned.
ENV STRATA_SCAN_PATHS="/mnt/hdd-pool /mnt/ssd-pool" \
    STRATA_SCAN_INTERVAL="86400" \
    STRATA_SCAN_SCHEDULE="" \
    STRATA_SCAN_PRECOUNT="false" \
    STRATA_KEEP_SNAPSHOTS="30" \
    STRATA_SCAN_ON_START="" \
    STRATA_HARDLINK_PRIORITY="" \
    STRATA_HARDLINK_COPIES="" \
    STRATA_DB_DIR="/var/lib/strata" \
    STRATA_LIB_DIR="/app/lib" \
    STRATA_APP_DIR="/app" \
    TZ="UTC"

EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
