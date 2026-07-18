# Deployment and CI/CD guide

This project now includes GitHub Actions workflows for:

- CI validation on pull requests and pushes to `main`
- Automatic deployment to **staging** on `main`
- Automatic deployment to **production** on `v*` tags
- Manual deployment to either environment with `workflow_dispatch`

## 1) Environments and topology

Recommended setup:

- **Staging**: frontend on Vercel and backend on Render
- **Production**: DigitalOcean droplet (Docker Compose), production domain
- Keep staging and production credentials fully separate

## 2) Required runtime prerequisites

- Staging on Vercel + Render with deploy hooks enabled
- Docker Engine + Docker Compose plugin on the production droplet
- Git installed on the production droplet
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

- `STAGING_RENDER_DEPLOY_HOOK_URL`
- `STAGING_VERCEL_DEPLOY_HOOK_URL`
- `STAGING_HEALTHCHECK_URL` (example: `https://staging-api.yourdomain.com/api/health`)

### Production secrets

- `PROD_SSH_HOST`
- `PROD_SSH_USER`
- `PROD_SSH_PRIVATE_KEY`
- `PROD_SSH_PASSPHRASE` (required if the private key is passphrase-protected)
- `PROD_APP_DIR` (example: `/opt/hillside-prod`)
- `PROD_REPO_ACCESS_TOKEN` (GitHub token with repository read access for clone/pull on droplet)
- `PROD_BACKEND_ENV_B64` (base64-encoded backend `.env`)
- `PROD_FRONTEND_ENV_B64` (base64-encoded frontend `.env`)
- `PROD_HEALTHCHECK_URL` (example: `https://api.yourdomain.com/api/health`)

You can generate base64 values locally (Linux/macOS) for production:

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

- Backend: `npm ci`, `npm run typecheck`, `npm run build`, `npm test`, config-manifest drift check
- Backend smoke: run migrations against ephemeral Postgres, `npm run migrate:verify --strict` (P3-3 ledger gate), strict config check, boot API, verify `/api/health`
- Migration round-trip + orphan shape (P3-3): on a fresh pgvector DB, apply the full tree, `migrate:down` the reversible tip, re-apply and assert the schema is byte-identical (up/down/up), then seed orphan `_migrations` rows (deleted-file rows) and assert migrate + verify still pass
- Frontend: `npm ci`, `npm run lint`, `npm run build`

### Deploy (`.github/workflows/deploy.yml`)

- `main` push -> staging deploy (triggers Render + Vercel deploy hooks)
- tag push `v*` -> production deploy over SSH (DigitalOcean droplet)
- manual deploy supported for both environments
- post-deploy health gate validates public `/api/health` URL before job is marked successful

Production deployment runs `scripts/deploy.sh`, which:

1. writes `backend/.env` and `frontend/.env` from GitHub secrets **atomically** (decode to a temp file, fail if empty, then `mv` into place — so a half-decoded env can never reach the running container)
2. runs `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build --remove-orphans` (the prod overlay adds restart policies, log rotation, memory limits, Postgres tuning, and tunable worker concurrency)
3. waits up to 150 s for `GET /api/health` to return 200 from inside the backend container before exiting non-zero
4. prunes dangling images and old build cache (`--keep-storage 1GB`) so the droplet disk does not silently fill up

## 8) Production host bootstrap (first time only)

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
- **Migrations roll back by re-deploy, not by `migrate:down`.** The runner applies the pending set in one batch transaction, so a *failed* migration leaves the schema byte-identical to before (nothing to undo). `npm run migrate:down` (P3-3) exists for local/CI round-trip testing and staging only, is gated behind `MIGRATE_ALLOW_DOWN=1`, and reverts only the reversible structural tip (files with a paired `NNN_name.down.sql`). Do not use it as a production rollback path — restore from backup or re-deploy the previous tag.

## 11) Production stability (DigitalOcean droplet)

If you previously saw the site go down on its own and only come back after you SSH'd in
and ran something, the cause was almost always one of these. They are all fixed in the
current `docker-compose.yml`, `docker-compose.prod.yml`, `scripts/deploy.sh` and
`backend/src/db/pool.ts`:

1. **Postgres pool was calling `process.exit(-1)` on idle errors.** Any transient blip
   (Postgres restart, brief OOM, network hiccup) killed the entire Node process. Now
   the pool just logs and `pg` recreates the broken client on the next acquire.

2. **No `restart` policy on any container.** When something crashed, Docker did not
   bring it back. Every service now uses `restart: unless-stopped`.

3. **No memory caps on Postgres / Redis / Node.** On a 2 GB droplet that means the
   kernel OOM killer eventually fires and silently kills a container. The prod overlay
   pins each container to a hard limit (Postgres 640M, Redis 224M, Node 900M with
   `NODE_OPTIONS=--max-old-space-size=768`, frontend 96M) so they all fit comfortably
   under 2 GB with room for the host.

4. **Worker concurrency was hard-coded** (10 webhook + 5 ai + 3 notif + 3 default + 1
   finetune = 22 concurrent jobs). On 1 vCPU that starves HTTP requests and they
   time out. The prod overlay drops them to 3/2/1/1/1 and exposes them as env
   variables (`WEBHOOK_WORKER_CONCURRENCY` etc.) so you can scale up later.

5. **Postgres + Redis ports were exposed to the public internet** (`5432:5432`,
   `6379:6379`). Now they're bound to `127.0.0.1` only — backend reaches them via
   the internal Docker network.

6. **Logs grew unbounded** until they filled the 47 GB droplet disk and froze
   everything. Compose now applies `json-file` with `max-size=10m`, `max-file=5` per
   container.

7. **No container-level healthcheck on the backend.** Docker now restarts it if
   `/api/health` stays unreachable.

### One-time droplet hardening (recommended)

```bash
# 1. Add a swap file so a memory spike does not instantly OOM-kill a service.
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# 2. Set the kernel to prefer killing the most memory-hungry container, not Postgres.
echo 'vm.overcommit_memory=1' | sudo tee /etc/sysctl.d/99-hillside.conf
sudo sysctl --system

# 3. Lock down the firewall so only 22, 80, 443 are public.
sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443
sudo ufw --force enable

# 4. Bind the host nginx (the one terminating TLS for app.byhillside.com /
#    api.byhillside.com) to proxy to 127.0.0.1:3000 (frontend) and
#    127.0.0.1:8000 (backend). The Compose ports already publish on those.
```

## 12) Two further production failure modes (fixed in this branch)

After the initial stability pass we saw a second incident where users got a flood of
`429 Too Many Requests` on `/api/auth/refresh` plus
`Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html"`
errors for chunks like `LoginPage-BTcUI8O8.js`. Both are now structurally fixed:

### A. Rate limit cascade (the 429)

The previous setup applied a single 100 req / 15 min limit to **every** endpoint, with
`/api/auth/refresh` sharing the same bucket. A normal SPA session burns 100 in minutes,
and once the bucket is exhausted *no one can log in or stay logged in* (the auth
interceptor retries 401 with a refresh, which then 429s).

It's now split:

- `/api/auth/login` and `/api/auth/register` — strict limiter (default 30 req / 15 min)
- everything else — generous limiter (default 1500 req / 15 min)
- `/api/health`, `/api/auth/refresh`, `/api/webhooks/*` — exempt entirely

Both limits are tunable via env vars without touching code:

- `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`
- `AUTH_RATE_LIMIT_WINDOW_MS`, `AUTH_RATE_LIMIT_MAX`

If the host nginx in front of the API is **not** sending `X-Forwarded-For`, the
`app.set('trust proxy', 1)` in `app.ts` falls back to the proxy's loopback IP and every
user shares one bucket. Make sure the host nginx site for `api.byhillside.com` includes:

```nginx
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

### B. Stale chunk MIME error (the "text/html" module script error)

Vite hashes every chunk by content. After a deploy:

1. Browser tab that was already open still references the **old** hash, e.g. `LoginPage-BTcUI8O8.js`.
2. The new container's `/usr/share/nginx/html/assets/` does not contain that file.
3. The previous nginx config did `try_files $uri $uri/ /index.html`, so the missing
   `.js` request *fell back to `index.html`*, which the browser then refused to execute
   ("expected JavaScript module, got HTML").

Fix is multi-layered:

- `frontend/docker/nginx.conf` now serves `/assets/*` with `try_files $uri =404;`
  (no SPA fallback for hashed assets) and adds:
  - `Cache-Control: public, max-age=31536000, immutable` for `/assets/*`
  - `Cache-Control: no-cache, no-store, must-revalidate` for `index.html`
  - **Do not** add a bare `types { ... }` block in that `server { }` — in nginx it
    replaces the inherited `mime.types`, so `.html` loses `text/html` and the browser
    may **download** `index.html` instead of rendering it (looks like “Rifresko faqen
    downloads a file”). Rely on the image’s default `include mime.types` at `http` level.
- `frontend/src/lib/lazyWithRetry.ts` wraps every `lazy()` so a chunk load failure
  triggers a one-shot full reload (sessionStorage flag prevents a reload loop).
- `frontend/src/components/ErrorBoundary.tsx` does the same for non-route lazy imports.
- `frontend/vite.config.ts` now splits `react`, `@tanstack`, `lucide-react`, and
  `sonner` into stable vendor chunks so a normal app deploy doesn't invalidate the
  whole bundle.

### Operational guidance

- After a frontend deploy, users with stale tabs will reload **once** automatically
  and pick up the new bundle. No action needed.
- If you ever want to be extra safe, you can also keep the previous deploy's
  `/assets/*` files around for ~15 minutes by mounting a host directory and copying
  rather than rebuilding the image — but with the lazyWithRetry helper this is
  generally unnecessary.

### Diagnosing the "login returns 500" symptom

The 500 from `POST /api/auth/login` and `POST /api/auth/refresh` is almost always one
of these — check in this order from the droplet:

```bash
cd ~/hillside-project
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=200 backend
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs --tail=100 postgres
```

Things to look for:

- `relation "refresh_tokens" does not exist` → the migration step in the backend
  Dockerfile failed (e.g. Postgres wasn't ready). Just `docker compose ... up -d`
  again — the backend container's CMD re-runs `node dist/db/migrate.js`.
- `column "persistent" of relation "refresh_tokens" does not exist` → same fix.
- `ECONNREFUSED 172.x.x.x:5432` → Postgres container is not up; check
  `docker compose ... ps` for an exited Postgres and inspect its logs (often OOM
  before the memory limits were applied).
- `OPENAI_API_KEY is not configured` or `[env] Missing required environment
  variables` → the env file on disk is empty/corrupt; redeploy so the atomic write
  in `scripts/deploy.sh` rewrites it.
- `[migrate] … has DRIFTED: recorded … != on-disk …` (P3-3) → an already-applied
  migration file was edited after it ran. Migrations are immutable — revert the
  edit and ship the change as a NEW migration. (At boot this only warns; the CI
  `migrate:verify --strict` gate is where it goes red.)
- `[migrate] … contains transaction-hostile SQL … but is not annotated
  '-- migrate:no-transaction'` (P3-3) → a pending migration self-commits or can't
  run in the batch transaction. Add the annotation on its own line so it runs
  standalone, and make that file individually idempotent (e.g.
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS`).
- **`INVALID` index after a failed `CREATE INDEX CONCURRENTLY`** → a no-transaction
  index build that failed mid-way leaves an invalid index (it is NOT rolled back —
  that is the nature of `CONCURRENTLY`). `DROP INDEX IF EXISTS <name>;` then re-run
  migrations; the `IF NOT EXISTS` build re-creates it cleanly.
