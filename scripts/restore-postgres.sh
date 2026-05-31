#!/usr/bin/env bash
#
# Restore Postgres from a .sql.gz created by backup-postgres.sh
# WARNING: overwrites data in database "hillside". Stop traffic or put app in maintenance first.
#
# Usage:
#   bash scripts/restore-postgres.sh /var/backups/hillside/hillside-20260101T120000Z.sql.gz

set -euo pipefail

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "Usage: bash scripts/restore-postgres.sh /path/to/hillside-YYYYMMDDTHHMMSSZ.sql.gz" >&2
  exit 1
fi

DUMP_FILE="$1"
APP_DIR="${APP_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$APP_DIR"

COMPOSE=(docker compose --env-file backend/.env --env-file frontend/.env -f docker-compose.yml)
if [ -f docker-compose.prod.yml ]; then
  COMPOSE+=(-f docker-compose.prod.yml)
fi

echo "[restore] Stopping backend to avoid writes during restore"
"${COMPOSE[@]}" stop backend || true

echo "[restore] Dropping and recreating public schema"
"${COMPOSE[@]}" exec -T postgres psql -U postgres -d hillside -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
SQL

echo "[restore] Loading ${DUMP_FILE}"
gunzip -c "$DUMP_FILE" | "${COMPOSE[@]}" exec -T postgres psql -U postgres -d hillside -v ON_ERROR_STOP=1

echo "[restore] Starting backend"
"${COMPOSE[@]}" start backend

echo "[restore] Done. Verify: curl https://api.byhillside.com/api/health"
