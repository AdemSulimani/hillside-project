# Production deployment checklist

Use this list before and after shipping Hillside CRM to production. Adjust hostnames, secrets stores, and orchestration (VM, Kubernetes, PaaS) to match your environment.

## Prerequisites

- **PostgreSQL** 16+ with extensions used by migrations (including `pgcrypto`, `vector` where applicable).
- **Redis** 7+ for BullMQ queues and rate limiting.
- **Node.js** 22 LTS (or run the provided **Docker** images).
- **Meta / OpenAI** credentials as required by your channels and AI features.
- **Sentry** project (optional but recommended) for backend error monitoring.

## Configuration

1. **Backend environment** — Copy `backend/.env.example` to `backend/.env` (or inject the same keys via your secret manager). Ensure at least:
   - `DATABASE_URL`, `REDIS_URL`
   - `JWT_SECRET`, `JWT_REFRESH_SECRET`
   - `OPENAI_API_KEY` (and embedding-related vars if you use product search embeddings)
   - `FRONTEND_URL` (exact browser origin, e.g. `https://app.example.com`)
   - `BACKEND_URL` (public API base used for attachment URLs, e.g. `https://api.example.com`)
   - `META_*`, `WEBHOOK_VERIFY_TOKEN`, `ENCRYPTION_KEY` for Meta channels
   - `SENTRY_DSN` when using Sentry
2. **Frontend build-time** — Set `VITE_API_URL` and `VITE_WS_URL` to the **browser-visible** API and WebSocket URLs (e.g. `https://api.example.com/api` and `wss://api.example.com`). Rebuild the SPA after any change.
3. **CORS / cookies** — Production must use **HTTPS** if you rely on `Secure` cookies. Align `FRONTEND_URL` with the SPA origin.
4. **Admin operations** — Set `ADMIN_KEY` if you use admin-only HTTP routes (e.g. tenant deletion).

## Database

1. Run migrations against the production database (from CI or a release job):

   ```bash
   cd backend && npm ci && npm run build && node dist/db/migrate.js
   ```

   Or rely on the backend Docker image entrypoint, which runs migrations before `node dist/server.js`.

2. Take an initial **backup** and schedule recurring backups / PITR according to your RPO/RTO.

## Application services

1. Deploy the **backend** process (or container) with `NODE_ENV=production`.
2. Deploy **BullMQ workers** if they run as a separate process in your setup (this repo starts workers from `server.ts` in the same Node process).
3. **Socket.IO horizontal scaling** — Realtime broadcasts use the **Redis adapter** (`REDIS_URL`). Every API replica must share the **same** Redis so inbox, orders, and AI alerts propagate across instances. Without that, users only see updates handled by the same replica they are connected to (often fixed by a full page refresh that refetches from the API).
4. Deploy the **frontend** static build behind **CDN or Nginx** with SPA fallback (`try_files … /index.html`).
5. Configure **health checks** (e.g. HTTP `GET /api/health` and `npm run healthcheck` in CI for DB/Redis/OpenAI smoke tests).

## Webhooks and Meta

1. Set Meta app **callback / webhook** URLs to your public API host.
2. Confirm `WEBHOOK_VERIFY_TOKEN` matches the Meta dashboard.
3. Validate **end-to-end** message flow: inbound webhook → persisted message → AI reply → optional order draft → inbox UI.

## Post-deploy verification

- [ ] Login, session refresh, and `GET /api/auth/me` succeed.
- [ ] Inbox loads conversations and message history; WebSocket updates work (`VITE_WS_URL`).
- [ ] Channels OAuth / webhook verification succeeds.
- [ ] Queue depth is healthy under load; Redis connectivity stable.
- [ ] Sentry receives a test error when `SENTRY_DSN` is set (optional debug route or controlled throw in staging only).
- [ ] Logs are aggregated (stdout JSON or shipper) and alerts wired (`ALERT_WEBHOOK_URL` if used).

## Rollback

- Keep the previous container images or release artifacts.
- Database: avoid destructive migrations without backups; document forward-only migration policy.

## Local Docker stack

From the repository root (after `cp backend/.env.example backend/.env` and filling secrets):

```bash
docker compose up --build
```

- **Postgres**: `localhost:5432` (user/password/db per `docker-compose.yml`).
- **Redis**: `localhost:6379`.
- **API**: `http://localhost:8000`.
- **SPA**: `http://localhost:3000` (Nginx serving the Vite build; API calls go to `localhost:8000` from the browser).
