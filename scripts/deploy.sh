#!/usr/bin/env bash
#
# Production / staging deploy on the droplet.
# Designed to be safe to re-run: env files are written atomically and only when valid,
# the production compose overlay is layered on top, and the API health endpoint must
# come back 200 before the script exits.

set -euo pipefail

ENVIRONMENT="${1:-}"

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "[deploy] Usage: bash scripts/deploy.sh <staging|production>"
  exit 1
fi

: "${APP_DIR:?APP_DIR is required}"
: "${BACKEND_ENV_B64:?BACKEND_ENV_B64 is required}"
: "${FRONTEND_ENV_B64:?FRONTEND_ENV_B64 is required}"

cd "$APP_DIR"

write_env_atomic() {
  local target="$1"
  local b64="$2"
  local tmp
  tmp="$(mktemp "${target}.tmp.XXXXXX")"
  if ! printf '%s' "$b64" | base64 -d > "$tmp"; then
    rm -f "$tmp"
    echo "[deploy] ERROR: failed to decode env for $target (invalid base64?)" >&2
    exit 1
  fi
  if [ ! -s "$tmp" ]; then
    rm -f "$tmp"
    echo "[deploy] ERROR: decoded env for $target is empty" >&2
    exit 1
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
}

echo "[deploy] Writing environment files for $ENVIRONMENT"
mkdir -p backend frontend
write_env_atomic backend/.env "$BACKEND_ENV_B64"
write_env_atomic frontend/.env "$FRONTEND_ENV_B64"

COMPOSE_FILES=(-f docker-compose.yml)
if [ -f docker-compose.prod.yml ]; then
  COMPOSE_FILES+=(-f docker-compose.prod.yml)
fi

echo "[deploy] Pulling base images"
docker compose "${COMPOSE_FILES[@]}" --env-file backend/.env --env-file frontend/.env pull --ignore-pull-failures || true

echo "[deploy] Building images (without starting)"
docker compose "${COMPOSE_FILES[@]}" \
  --env-file backend/.env \
  --env-file frontend/.env \
  build

# Run database migrations BEFORE bringing the new containers up.
#
# Running them here means the schema is always ahead of the code, not racing
# with it. The `--rm` flag removes the one-shot container immediately after.
# We mount no new volumes — the migration container connects to the same
# Postgres service already running on the host network.
#
# IMPORTANT: migrations must be idempotent (all use IF NOT EXISTS / ON CONFLICT)
# so re-running on a failed deploy is always safe.
echo "[deploy] Running database migrations"
docker compose "${COMPOSE_FILES[@]}" \
  --env-file backend/.env \
  --env-file frontend/.env \
  run --rm backend node dist/db/migrate.js

echo "[deploy] Starting containers"
docker compose "${COMPOSE_FILES[@]}" \
  --env-file backend/.env \
  --env-file frontend/.env \
  up -d --remove-orphans

echo "[deploy] Waiting for backend health"
for i in $(seq 1 30); do
  if docker compose "${COMPOSE_FILES[@]}" exec -T backend node -e \
        "require('http').get('http://127.0.0.1:8000/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" \
        >/dev/null 2>&1; then
    echo "[deploy] Backend reports healthy"
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "[deploy] ERROR: backend never became healthy" >&2
    docker compose "${COMPOSE_FILES[@]}" logs --tail=200 backend >&2 || true
    exit 1
  fi
  sleep 5
done

echo "[deploy] Cleaning old images and build cache"
docker image prune -f
docker builder prune -f --keep-storage 1GB || true

echo "[deploy] Completed $ENVIRONMENT deployment"
