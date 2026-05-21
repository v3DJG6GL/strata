# DUC Advanced -- interactive disk-usage visualizer.
FROM debian:trixie-slim

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends lighttpd python3 procps; \
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
ENV DUC_SCAN_PATHS="/mnt/hdd-pool /mnt/ssd-pool" \
    DUC_SCAN_INTERVAL="86400" \
    DUC_KEEP_SNAPSHOTS="30" \
    DUC_HARDLINK_PRIORITY="" \
    DUC_HARDLINK_COPIES="" \
    DUC_DB_DIR="/var/lib/duc" \
    DUC_LIB_DIR="/app/lib" \
    DUC_APP_DIR="/app"

EXPOSE 8000
ENTRYPOINT ["/app/entrypoint.sh"]
