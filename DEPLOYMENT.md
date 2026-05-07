# Deployment and CI/CD guide

This project now includes GitHub Actions workflows for:

- CI validation on pull requests and pushes to `main`
- Automatic deployment to **staging** on `main`
- Automatic deployment to **production** on `v*` tags
- Manual deployment to either environment with `workflow_dispatch`

## 1) Environments and topology

Recommended setup:

- **Staging**: separate VM or container host, separate DB and Redis, staging domain
- **Production**: isolated VM/cluster, production DB and Redis, production domain
- Keep staging and production credentials fully separate

## 2) Required runtime prerequisites

- Docker Engine + Docker Compose plugin on each host
- Git installed on each host
- Public GitHub repository access from hosts (or deploy key/token if private)
- PostgreSQL 16+ and Redis 7+ reachable from backend

## 3) Configure environment files

Backend keys come from `backend/.env.example`.
Frontend keys come from `frontend/.env.example`.

At minimum in each backend env:

- `DATABASE_URL`, `REDIS_URL`
- `JWT_SECRET`, `JWT_REFRESH_SECRET`, `ADMIN_JWT_SECRET`
- `OPENAI_API_KEY`
- `FRONTEND_URL`, `BACKEND_URL`
- `META_*`, `WEBHOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY` (if Meta channels are enabled)

At minimum in each frontend env:

- `VITE_API_URL`
- `VITE_WS_URL`

## 4) GitHub environments (must do)

Create 2 GitHub environments in repo settings:

- `staging`
- `production`

Enable protection rules:

- `production`: required reviewers (recommended), optional wait timer
- `staging`: optional reviewers

These map to the workflow jobs in `.github/workflows/deploy.yml`.

## 5) GitHub secrets to add

### Staging secrets

- `STAGING_SSH_HOST`
- `STAGING_SSH_USER`
- `STAGING_SSH_PRIVATE_KEY`
- `STAGING_APP_DIR` (example: `/opt/hillside-staging`)
- `STAGING_BACKEND_ENV_B64` (base64-encoded backend `.env`)
- `STAGING_FRONTEND_ENV_B64` (base64-encoded frontend `.env`)
- `STAGING_HEALTHCHECK_URL` (example: `https://staging-api.yourdomain.com/api/health`)

### Production secrets

- `PROD_SSH_HOST`
- `PROD_SSH_USER`
- `PROD_SSH_PRIVATE_KEY`
- `PROD_APP_DIR` (example: `/opt/hillside-prod`)
- `PROD_BACKEND_ENV_B64` (base64-encoded backend `.env`)
- `PROD_FRONTEND_ENV_B64` (base64-encoded frontend `.env`)
- `PROD_HEALTHCHECK_URL` (example: `https://api.yourdomain.com/api/health`)

You can generate base64 values locally (Linux/macOS):

```bash
base64 -w 0 backend/.env
base64 -w 0 frontend/.env
```

PowerShell (Windows):

```powershell
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content backend/.env -Raw)))
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Content frontend/.env -Raw)))
```

## 6) Branch and release strategy

Recommended promotion flow:

1. Create feature branch from `main`
2. Open PR, wait for CI to pass
3. Merge to `main`
4. `main` auto-deploys to staging
5. Validate staging smoke tests
6. Create release tag (example `v1.4.0`) from the promoted commit
7. Tag push deploys production (with production environment approval)

## 7) Workflows included

### CI (`.github/workflows/ci.yml`)

- Backend: `npm ci`, `npm run typecheck`, `npm run build`
- Backend smoke: run migrations against ephemeral Postgres, boot API, verify `/api/health`
- Frontend: `npm ci`, `npm run lint`, `npm run build`

### Deploy (`.github/workflows/deploy.yml`)

- `main` push -> staging deploy
- tag push `v*` -> production deploy
- manual deploy supported for both environments
- post-deploy health gate validates public `/api/health` URL before job is marked successful

Deployment runs `scripts/deploy.sh`, which:

1. writes `backend/.env` and `frontend/.env` from GitHub secrets
2. runs `docker compose up -d --build`
3. prunes dangling images

## 8) Host bootstrap (first time only)

On each host:

```bash
sudo mkdir -p /opt/hillside-staging
sudo chown -R $USER:$USER /opt/hillside-staging
```

And similarly for production (for example `/opt/hillside-prod`).

Ensure the deploy user can run Docker without sudo:

```bash
sudo usermod -aG docker $USER
```

Then re-login.

## 9) Post-deploy verification checklist

- `GET /api/health` returns 200
- Login and refresh token flow works
- Realtime updates work from UI (`VITE_WS_URL`)
- Meta webhooks verify and inbound messages process
- Queue processing is healthy and Redis stable
- Staging-only controlled error appears in Sentry (if configured)

## 10) Rollback strategy

- Re-deploy previous known-good tag to production
- Keep DB migrations forward-safe; avoid destructive migrations without backup
- Maintain automated DB backups + restore drills
