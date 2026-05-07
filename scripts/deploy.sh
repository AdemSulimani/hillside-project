#!/usr/bin/env bash

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

echo "[deploy] Writing environment files for $ENVIRONMENT"
printf "%s" "$BACKEND_ENV_B64" | base64 -d > backend/.env
printf "%s" "$FRONTEND_ENV_B64" | base64 -d > frontend/.env

echo "[deploy] Building and starting containers"
docker compose up -d --build

echo "[deploy] Cleaning old images"
docker image prune -f

echo "[deploy] Completed $ENVIRONMENT deployment"
