#!/usr/bin/env bash
#
# Logical backup of Postgres (pg_dump) for hillside-project on the droplet.
# Usage:
#   cd ~/hillside-project && bash scripts/backup-postgres.sh
# Optional env:
#   BACKUP_DIR=/var/backups/hillside
#   RETENTION_DAYS=14

set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/hillside}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

cd "$APP_DIR"

COMPOSE=(docker compose --env-file backend/.env --env-file frontend/.env -f docker-compose.yml)
if [ -f docker-compose.prod.yml ]; then
  COMPOSE+=(-f docker-compose.prod.yml)
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_FILE="${BACKUP_DIR}/hillside-${TIMESTAMP}.sql.gz"

echo "[backup] Dumping database to ${OUT_FILE}"
"${COMPOSE[@]}" exec -T postgres pg_dump -U postgres -d hillside --no-owner --no-acl | gzip -9 > "$OUT_FILE"

chmod 600 "$OUT_FILE"
echo "[backup] OK ($(du -h "$OUT_FILE" | awk '{print $1}'))"

if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  echo "[backup] Removing dumps older than ${RETENTION_DAYS} days"
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'hillside-*.sql.gz' -mtime +"$RETENTION_DAYS" -delete
fi

echo "[backup] Recent backups:"
ls -lht "$BACKUP_DIR"/hillside-*.sql.gz 2>/dev/null | head -5 || true
