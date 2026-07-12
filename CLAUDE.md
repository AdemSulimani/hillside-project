# CLAUDE.md — Hillside Project

## Architecture Note

Some parts of the current architecture are under review and may not represent the ideal long-term design. When analyzing or suggesting improvements, do not treat existing patterns as hard constraints — feel free to question and recommend better approaches where appropriate.

---

## 1. Product Overview

**Hillside** (`byhillside.com`) is a B2B SaaS platform that gives businesses an AI-powered sales assistant and CRM for social/messaging channels — Facebook Messenger, Instagram Direct, WhatsApp Business, and Viber. The company is registered as Hillside L.L.C. in Kosovo. The primary market is Albanian-speaking businesses, though the platform and AI fully support English.

**The problem it solves:** Most  businesses that sell via social media manage chats manually — someone on the team reads every message, answers product questions, collects delivery details, and records orders by hand. Hillside replaces this with an AI assistant that handles the full sales and support conversation autonomously: answering all product questions, recommending items, quoting prices, collecting order details, and confirming orders. When the AI encounters something it cannot handle confidently (a cancellation, refund, sensitive complaint, or low-confidence question), it escalates and steps back.

**There are three distinct user types:**
- **Business users** — paying Hillside customers (owners and staff) who manage inbox, orders, catalog
- **End customers** — people who message a business on a social channel; they never log into Hillside
- **Platform admins** — Hillside's own internal team with a separate admin portal to manage all tenants, billing, and global AI behavior

**Business model:** Usage-based and performance-based.
- A **5% commission** on every order fully created by AI (no human agent replied in that conversation session)
- **Tiered per-conversation fees** for AI-resolved support cases with no order and no human involvement: €0.50/case for 0–250 cases/month, €0.40 for 251–500, €0.30 for 501–1000, €0.20 for 1000+
- Billing is monthly in EUR on an invoice basis (no in-app payment processor)

---

## 2. Repository Structure

This is a **two-package repo** with no monorepo tool (no Turborepo, Nx, or Lerna). The root has no `package.json`.

```
hillside-project/
├── backend/                 # Node/Express API (TypeScript)
├── frontend/                # React/Vite SPA (TypeScript)
├── scripts/                 # Ops scripts: deploy.sh, backup-postgres.sh, restore-postgres.sh
├── .github/workflows/       # CI (ci.yml) and deployment (deploy.yml) GitHub Actions
├── docker-compose.yml       # Local/prod Docker Compose
├── docker-compose.prod.yml  # Production overlay (memory limits, tuned concurrency)
└── DEPLOYMENT.md            # CI/CD and deployment guide
```

### `backend/src/` subdirectories

| Directory | Responsibility |
|-----------|---------------|
| `config/` | Environment validation (`validateEnv.ts`) |
| `controllers/` | HTTP request handlers — auth, products, channels, webhooks, orders, admin, AI, etc. |
| `db/` | PostgreSQL: `pool.ts`, `migrate.ts`, SQL migrations (`migrations/`), data-access models (`models/`) |
| `jobs/` | BullMQ job processors, workers, queues, Bull Board dashboard, schedulers |
| `middleware/` | Auth, validation, uploads, rate limiting, error handling |
| `routes/` | Express router definitions, mounted in `app.ts` |
| `scripts/` | CLI utilities: migrations, embeddings, health check, platform owner creation |
| `services/` | Business logic — AI pipeline, product processing, channels, embeddings, storage, billing, etc. |
| `services/documents/` | PDF/spreadsheet/OCR parsing service hierarchy |
| `services/__tests__/` | Unit tests |
| `sockets/` | Socket.IO server setup with Redis adapter |
| `types/` | Shared TypeScript types |
| `utils/` | Helpers: response envelope, tenant scoping, PG error codes, text encoding |
| Root (`app.ts`, `server.ts`, `bootstrap.ts`, `instrument.ts`) | Express wiring, HTTP server, Sentry, startup |

### `frontend/src/` subdirectories

| Directory | Responsibility |
|-----------|---------------|
| `api/` | Axios API client modules per domain (13 modules) |
| `components/` | UI + feature components: `auth/`, `channels/`, `contacts/`, `inbox/`, `layouts/`, `orders/`, `products/`, `ui/` (shadcn) |
| `contexts/` | React contexts: `CrmSocketContext`, `ProductsUIContext` |
| `hooks/` | Custom hooks: `useAuth`, debounce, WhatsApp embedded signup, toasts |
| `lib/` | `api.ts` (axios client), `socket.ts`, `query-client`, `formatCurrency`, `formatRelativeTime`, `adminApi.ts` |
| `pages/` | Route-level screens: `admin/`, `aiAlerts/`, `auth/`, `business/`, `channels/`, `chatbotControl/`, `contacts/`, `credits/`, `crm/`, `dashboard/`, `feedback/`, `inbox/`, `legal/`, `onboarding/`, `orders/`, `products/`, `profile/`, `statistics/` |
| `store/` | Zustand stores: `authStore`, `adminAuthStore`, `app` |
| `types/` | Frontend TypeScript interfaces per domain |

---

## 3. Tech Stack

### Backend

| Area | Choice |
|------|--------|
| Language / Runtime | TypeScript ^6, Node 22 |
| Framework | Express ^5 |
| Database | PostgreSQL 16 with `pgvector` extension — accessed via raw `pg` ^8 (no ORM) |
| Migrations | Custom runner (`db/migrate.ts`) over numbered `.sql` files in `db/migrations/` |
| Cache | Redis via `ioredis` |
| Job queue | BullMQ + Bull Board dashboard (queues: `webhook`, `ai`, `notifications`, `finetuning`, `default`) |
| Real-time | Socket.IO with `@socket.io/redis-adapter` for multi-instance fan-out |
| AI | OpenAI SDK ^6 — multiple models configurable per role (chat, vision, embedding, intent, eval) |
| Image storage | Cloudinary (product/logo images) |
| File storage | Backblaze B2 via AWS S3 SDK (general attachments) |
| Image processing | sharp, Tesseract.js (OCR) |
| Auth | JWT (access token, 15 min) + httpOnly refresh cookie; separate admin JWT; AES-encrypted channel tokens |
| Validation | Zod |
| Observability | Sentry, Morgan |
| Other | multer, helmet, cors, express-rate-limit, pdf-parse, xlsx (SheetJS) |

### Frontend

| Area | Choice |
|------|--------|
| Framework | React ^19 + Vite ^8 (SPA, not Next.js) |
| Routing | React Router v7 |
| Language | TypeScript ~6 |
| Styling | Tailwind CSS ^4 |
| State — server | TanStack React Query v5 |
| State — client | Zustand v5 |
| UI components | shadcn/ui built on `@base-ui/react`, `lucide-react` icons |
| Charts | recharts |
| Tables | @tanstack/react-table |
| HTTP | axios (with interceptors for auth + token refresh) |
| Real-time | socket.io-client |
| Toasts | sonner |
| Validation | Zod |

---

## 4. Development Setup

### Run locally (Docker — recommended)

```bash
# From repo root
docker compose up --build
```

- Postgres: `127.0.0.1:5432`
- Redis: `127.0.0.1:6379`
- Backend API: `http://localhost:8000`
- Frontend (Nginx): `http://localhost:3000`

Requires a `.env` at repo root (Compose env vars) and `backend/.env` (copy from `backend/.env.example`).

### Run locally (manual)

```bash
# Backend
cd backend
cp .env.example .env   # fill in required vars
npm ci
npm run migrate
npm run dev            # port 8000, hot reload via tsx

# Frontend
cd frontend
cp .env.example .env   # set VITE_API_URL, VITE_WS_URL
npm ci
npm run dev            # Vite HMR
```

### Backend scripts (`cd backend && npm run <script>`)

| Script | Purpose |
|--------|---------|
| `dev` | Dev server with hot reload (`tsx watch`) |
| `build` | Compile TypeScript to `dist/` |
| `start` | Run production build |
| `typecheck` | Type-check without emit |
| `test` | Run unit tests (Node built-in runner via `tsx --test`) |
| `migrate` | Run DB migrations |
| `embed-all` | Batch-embed all products |
| `create-platform-owner` | Create platform admin account |
| `encrypt-token` | Encrypt a channel access token |
| `healthcheck` | CLI health check |

### Frontend scripts (`cd frontend && npm run <script>`)

| Script | Purpose |
|--------|---------|
| `dev` | Vite dev server |
| `build` | `tsc -b && vite build` — type-check + production bundle |
| `lint` | ESLint |
| `preview` | Preview production build locally |

### Tests

```bash
cd backend && npm test
```

Tests live in `backend/src/services/__tests__/`. CI does **not** run `npm test` — it runs typecheck, build, migration smoke-test, and health endpoint check.

### Production

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

---

## 5. Architecture

### Overview

```
Browser (React + Axios + React Query + Zustand)
    ↕ REST /api/*  +  Socket.IO (per-tenant rooms)
Express (routes → middleware → controllers → services/db models)
    ↕
PostgreSQL (shared schema, row-level tenant isolation) + Redis (cache, queues, socket adapter)
    ↕
External: OpenAI, Cloudinary, Backblaze, Meta Graph API, Viber API
```

### Layering

```
routes → middleware → controllers → services → db/models
```

There is **no ORM and no repository layer**. `db/models/*.ts` files are the data-access layer — they export async functions that run parameterized raw SQL against `db/pool.ts`. Controllers and services call these directly.

### Controller pattern

Controllers export named `async` functions (not classes). They:
1. Read `req.user!.tenantId!` for tenant scope
2. Use validated input from `req.validated` or `req.body`
3. Call `db/models` and/or services
4. Respond via `sendSuccess` / `sendError` / `sendPaginated` (from `utils/response.ts`)
5. Handle errors locally with `try/catch` → `sendError`

### Service patterns

Three co-existing patterns — no dependency injection framework:

| Pattern | When used | Examples |
|---------|-----------|---------|
| Plain exported functions | Stateless logic | `conversationService`, `tokenService`, `creditsService` |
| Singleton instance | Shared stateful service | `cryptoService`, `webhookNormalizerService`, `socketService` |
| `new Class(tenantId)` per request | Tenant-scoped processing | `AIProductProcessingService`, `AttachPdfService` |
| Factory function | Type-based selection | `getDocumentService(tenantId, mimetype)` |

### API design

- **REST over HTTP/JSON only** — no GraphQL, no tRPC
- Base path: `/api`
- Standard response envelope (from `utils/response.ts`):
  ```json
  { "success": true, "data": <T>, "message": "..." }
  { "success": false, "message": "...", "error": "..." }
  { "success": true, "data": [...], "pagination": { "page", "limit", "total", "totalPages" } }
  ```
- Note: some list endpoints embed pagination inside `data` rather than using `sendPaginated` — both patterns exist in the codebase

### Route namespaces (all under `/api`)

| Prefix | Purpose |
|--------|---------|
| `/auth` | Register, login, logout, refresh, me |
| `/onboarding` | Business setup wizard |
| `/business`, `/profile`, `/dashboard` | Tenant settings and overview |
| `/products`, `/channels`, `/conversations`, `/orders`, `/contacts` | CRM core |
| `/ai-config`, `/chatbot`, `/ai-alerts`, `/feedback`, `/escalations` | AI features |
| `/statistics`, `/credits` | Analytics and billing |
| `/oauth` | Meta/Instagram OAuth |
| `/webhooks` | Inbound channel webhooks |
| `/admin` | Platform owner portal |
| `/health` | Health checks |

### Authentication

Three independent auth paths:

| Path | Middleware | Token | Used for |
|------|-----------|-------|---------|
| Business users | `authenticate` | JWT Bearer, `JWT_SECRET` | All CRM routes |
| Onboarding gate | `ensureOnboarded` | Requires `tenantId` in JWT | Routes that need tenant context |
| Platform admin | `authenticateAdmin` | JWT Bearer, `ADMIN_JWT_SECRET` | `/api/admin/*` |
| Bull Board | `requireAdminKey` | `X-Admin-Key` header | Queue dashboard |

Access tokens: 15 min. Refresh: httpOnly cookie at `/api/auth`, rotated on `/auth/refresh`.

### Multi-tenancy

**Shared database, shared schema, row-level isolation via `tenant_id`.**

- The tenant entity is the `tenants` table (the UI calls it "business")
- `tenant_id` is present on all business data: channels, contacts, conversations, messages, products, orders, ai_configs, etc.
- Controllers pass `tenantId` (from `req.user.tenantId`) into every query
- No schema-per-tenant, no RLS — isolation is entirely at the application query level
- Webhooks resolve the tenant via channel ID in the URL/body (no JWT)
- Socket.IO rooms: `tenant:{tenantId}` — joined after JWT verification

### Real-time (Socket.IO)

- Server: Socket.IO on same HTTP server, with Redis adapter for multi-instance
- Auth: JWT in `socket.handshake.auth.token`
- Events: `new_message`, `conversation_updated`, `message_edited`, `order_created`, `order_updated`, `order_action_required`, `ai_alert`, `message_send_failed`
- Frontend: `CrmSocketContext` (scoped to CRM layout) patches TanStack Query cache on socket events

### Background jobs (BullMQ)

| Queue | Key job types |
|-------|--------------|
| `webhook` | Inbound webhook processing per channel |
| `ai` | `ai.reply` (main AI pipeline), `evaluateConversationUseCase` |
| `notifications` | Outbound alert notifications |
| `finetuning` | Fine-tuning data prep, status polling |
| `default` | Product embeddings, image fingerprints |

Scheduled cron jobs: embedding reconciliation (6h), image fingerprint reconciliation, Meta token refresh (weekly), fine-tuning prep (nightly), monthly use-case billing snapshot (1st of month, 00:05 UTC).

### File uploads

- Multer with `memoryStorage()` in `middleware/upload.ts`
- Images/logos → Cloudinary (`cloudinaryService.ts`)
- General files/attachments → Backblaze B2 (`backblazeService.ts`)
- Document parsing: class hierarchy in `services/documents/` (PDF via `pdf-parse`, spreadsheets via SheetJS, OCR via Tesseract.js)

### Frontend architecture

- Routing: React Router v7 with lazy-loaded pages (`lazyWithRetry`)
- Layout nesting: `ProtectedRoute` → `RequireOnboarding` → `CRMLayout` (sidebar + header + socket provider)
- Admin area: separate `AdminProtectedRoute` + `AdminLayout`
- API calls: Axios with Bearer token interceptor + single-flight 401 refresh queue
- Admin API: separate `adminApi.ts` client — no cookie refresh, redirects to `/admin/login` on 401/403
- Path alias: `@/` → `frontend/src/`

---

## 6. Data Model

The database schema is defined across **69 SQL migration files** in `backend/src/db/migrations/` (ordinals `001`–`068`; ordinal `062` is used by two files — `062_message_product_context.sql` and `062_compact_edge_case_guidelines.sql`). The runner (`db/migrate.ts`) applies files in **lexicographic filename order** with a per-file `BEGIN/COMMIT`, so the numeric prefix is not a strict apply-order contract and is not unique. There is no Prisma, TypeORM, or single consolidated schema file. TypeScript interfaces and query functions live in `backend/src/db/models/*.ts`.

Extensions: `pgcrypto`, `pgvector` (1536-dim vectors on `products` and `product_image_fingerprints`).

### Core entities

**`tenants`** — the business/merchant account; root of multi-tenancy  
Key fields: `id` (UUID), `name`, `niche`, `description`, `delivery_methods` (JSONB), `delivery_time` (`'24h'`/`'48h'`/`'72h'`), `logo_url`, `plan` (default `'free'`)

**`users`** — tenant owner/staff login accounts  
Key fields: `id`, `tenant_id` (nullable until onboarding), `name`, `email`, `password_hash`, `role` (default `'owner'`)

**`platform_owners`** — Hillside internal admin accounts (separate from tenant users, no `tenant_id`)

**`channels`** — connected messaging accounts  
Key fields: `tenant_id`, `type` (`'facebook'`/`'instagram'`/`'whatsapp'`/`'viber'`), `external_id`, `access_token_encrypted`, `connection_method`, `ai_enabled`  
Unique: `(tenant_id, type, external_id)`

**`contacts`** — end customers who have messaged the business  
Key fields: `tenant_id`, `channel_id` (nullable after disconnect), `external_id` (platform user ID), `name`, `notes`  
Unique: `(tenant_id, channel_id, external_id)`

**`conversations`** — a messaging thread: one contact × one channel × one tenant  
Key fields: `tenant_id`, `contact_id`, `channel_id` (nullable), `status` (`'open'`/`'closed'`), `ai_paused`, `human_replied` (sticky flag — any human reply ever), `human_override_until` (temporary hold), `fully_ai_handled`  
Unique: `(tenant_id, contact_id, channel_id)`

**`messages`** — individual messages in a conversation  
Key fields: `conversation_id`, `direction` (`'inbound'`/`'outbound'`), `type` (`'text'`/`'image'`/`'audio'`/`'video'`/`'document'`), `sent_by` (`'customer'`/`'ai'`/`'human'`), `ai_processed`, `quality_score` (0.0–1.0), `flagged`, `flag_reason`, `product_ids` (JSONB — catalog UUIDs referenced by AI)

**`products`** — tenant catalog  
Key fields: `tenant_id`, `name`, `brand`, `price`, `discounted_price`, `description`, `usage_description`, `sku`, `category`, `flavor`, `size`, `color`, `variant`, `weight`, `tags` (JSONB), `image_urls` (JSONB), `is_active`, `in_stock`, `source_type`, `embedding` (vector 1536), `deleted_at` (soft delete)  
Unique: `(tenant_id, LOWER(TRIM(name))) WHERE deleted_at IS NULL`

**`product_image_fingerprints`** — vision-extracted fingerprints + embeddings for image-based product matching  
Key fields: `product_id`, `image_url`, `fingerprint_json`, `fingerprint_text`, `embedding` (vector 1536)

**`orders`** — orders created from conversations (only AI creates new order rows via the pipeline)  
Key fields: `conversation_id`, `contact_id`, `product_id` (nullable), `product_name` (denormalized), `quantity`, `unit_price`, `total_price`, `status`, `customer_name`, `customer_phone`, `delivery_address`, `detected_by` (default `'ai'`), `is_commissionable`, `commission_amount` (5% of total), `commission_status` (`'unpaid'`/`'billed'`/`'paid'`)  
Order statuses: `draft` → `confirmed` → `processing` → `shipped` → `delivered` / `cancelled` / `refunded`

**`ai_configs`** — per-tenant AI personality; **one row per tenant** (UNIQUE on `tenant_id`)  
Key fields: `tone`, `personality_description`, `restrictions`, `sales_strategy`, `objection_handling`, `qa_pairs` (JSONB), `is_active`, `custom_model_id` (fine-tuned model override), `feedback_count`

**`prompt_blocks`** — global platform catalog of AI guideline blocks (no `tenant_id`)  
Key fields: `key`, `title`, `default_content`, `category` (`'guidelines'`/`'vision'`), `is_platform_locked`

**`tenant_prompt_blocks`** — per-tenant copy/customization of prompt blocks  
Key fields: `tenant_id`, `block_key`, `enabled`, `content`, `sort_order`  
Unique: `(tenant_id, block_key)`

**`ai_alerts`** — escalation and quality alerts  
Key fields: `tenant_id`, `conversation_id` (nullable for system alerts), `message_id`, `reason`, `status` (`'unread'`/`'read'`/`'resolved'`)  
Alert reasons include: `cancellation_request`, `refund_request`, `post_purchase_support_request`, `product_question_unanswered`, `usage_question_unanswered`, `product_image_unavailable`, `hallucinated_price`, `hallucinated_product_name`, `uncertain_answer_escalated`, `order_info_updated`, `message_send_failed`, `rate_limit_exceeded`, `token_refresh_failed`. Low-quality replies are additionally flagged under the quality-eval reasons `off_topic`, `irrelevant`, `misleading`, `unclear`, and `low_confidence`.

**`ai_use_cases`** — billable support conversations fully resolved by AI  
Key fields: `conversation_id` (UNIQUE — one use case per conversation), `status` (`'completed'`/`'voided'`), `billing_status` (`'unbilled'`/`'billed'`/`'paid'`), `fee_amount` (stamped at month-end), `billing_period` (`'YYYY-MM'`)

**`commission_reports`** — saved billing period summaries per tenant  
Key fields: `tenant_id`, `period_start`, `period_end`, `commission_amount` (from AI orders), `use_case_count`, `use_case_amount`, `status` (`'unpaid'`/`'billed'`/`'paid'`)

**`feedback_logs`** — human corrections of AI replies for fine-tuning  
Key fields: `message_id`, `original_ai_response`, `corrected_response`, `reason`, `status` (`'pending'`/`'included_in_training'`)

**`analytics_events`** — append-only event log (never updated/deleted)  
Event types: `message_received`, `ai_reply_sent`, `human_reply_sent`, `order_created`, `order_confirmed`, `feedback_submitted`

### Relationships summary

```
tenants
  ├── users (many)
  ├── channels (many)
  ├── contacts (many)
  ├── conversations (many)
  │     ├── messages (many)
  │     ├── orders (many)
  │     └── ai_use_cases (one — UNIQUE)
  ├── products (many)
  │     └── product_image_fingerprints (many)
  ├── orders (many)
  ├── ai_configs (one — UNIQUE)
  ├── tenant_prompt_blocks (many)
  ├── ai_alerts (many)
  ├── feedback_logs (many)
  ├── commission_reports (many)
  └── analytics_events (many)

prompt_blocks (global) ──< tenant_prompt_blocks (per tenant)
channels ──< contacts (channel_id nullable on disconnect)
channels ──< conversations (channel_id nullable on disconnect)
contacts ──< conversations, orders, ai_use_cases
messages (self-referential reply FK)
```

---

## 7. AI Services Architecture

### Services and their responsibilities

| Service file | Responsibility |
|-------------|---------------|
| `aiService.ts` | Core reply generation — builds system prompt, retrieves product context (vector + keyword fusion), injects prompt blocks, calls OpenAI chat API |
| `processAIReply.ts` (in `jobs/`) | Orchestrator — full runtime pipeline for AI reply jobs: gating, burst merge, intent routing, calling `generateReply`, post-reply guards, outbound send, draft order creation |
| `intentDetectionService.ts` | Detects purchase intent and order-state from conversation: `is_ready_to_order`, `intent_score`, `product_name`, `hasDeliveryAddress`, `hasCustomerName`, `hasCustomerPhone` |
| `productAttributeIntentService.ts` | Detects which product attributes the customer is asking about (flavor, size, color, etc.) |
| `productAttributeAvailabilityService.ts` | Checks whether requested attribute combinations exist in the catalog; computes missing structured attributes |
| `productInformationGapService.ts` | Assesses whether a product information request was fully answered; flags knowledge gaps for partial-answer escalation |
| `aiQualityService.ts` | Evaluates AI reply quality via a separate eval model; flags/pauses on low scores |
| `AIProductProcessingService.ts` | Processes product imports from documents/images — extracts structured product data using AI, handles PDF/spreadsheet/image source types |
| `productImageMatchingService.ts` | Matches customer-sent photos to catalog products using vector similarity over image fingerprints |
| `productImageFingerprintService.ts` | Generates vision-based fingerprints (brand, flavor, attributes, confidence) + embeddings for catalog product images |
| `openaiClient.ts` | OpenAI SDK client singleton; all AI calls go through this |

### AI reply pipeline (`processAIReply.ts`)

The main pipeline runs as a BullMQ job (`ai.reply`) triggered on every inbound message:

1. **Concurrency controls** — per-tenant slot limit (Redis), per-conversation lock (Redis), per-conversation rate limit (25 replies/hour)
2. **Enablement gates** — checks `ai_configs.is_active`, `channels.ai_enabled`, `conversations.ai_paused`, `human_override_until`
3. **Message normalization** — load history, merge burst messages, skip reactions/emoji-only/stale jobs
4. **Pre-reply special paths** (before LLM call) — cancellation/refund detection → canned response + order flag; post-purchase support; order info updates (name/phone/address/quantity)
5. **Core reply** — calls `aiService.generateReply()` with conversation history + product context
6. **Post-reply guards** (applied to draft reply before sending):
   - Usage question unanswered detection
   - Product knowledge gap detection → partial answer + escalation
   - Speculative health advice classifier → block or escalate
   - Price hallucination filter → strip wrong prices
   - Product name hallucination filter → strip invented SKUs
   - Quality evaluation (separate eval model) → flag/pause below threshold
   - Order confirmation formatting → inject delivery ETA + closing
7. **Outbound send** — sanitize, send via channel API, persist message, emit socket events, log analytics
8. **Draft order creation** — runs after send, only when all conditions pass (intent score > 0.85, has product name + phone + name + address, order affirmation detected)

### Product retrieval (inside `aiService.ts`)

Products are found for each conversation using **fusion retrieval**: vector similarity search over `products.embedding` (pgvector cosine distance, threshold from `SIMILARITY_THRESHOLD`) combined with keyword matching. Matched products are injected into the system prompt as structured context.

### Draft order → commission decision

Commission eligibility (`is_commissionable`) is decided at draft-order creation time:
- `hasHumanParticipationInCurrentOrderWindow()` checks whether a human replied within the current "order session" (session gap: `COMMISSION_SESSION_GAP_HOURS`, default 3h)
- If no human participated in the window: `is_commissionable = true`, `commission_amount = total * 0.05`
- `conversations.human_replied` is sticky (once true, always true) and disqualifies **use cases** — but order commissions use the session-window check, so a human reply in a past session does not block future AI orders

### Use case vs. commission mutual exclusivity

```
Conversation fully resolved by AI, no human, no order → ai_use_cases row (progressive fee)
Conversation where AI creates + confirmed order → order commission (5%)
If a commissionable order is confirmed on a conversation that has an unbilled use case → use case is voided
```

### Prompt block system

Platform admins maintain a global `prompt_blocks` catalog. On tenant creation (or manual sync), blocks are copied into `tenant_prompt_blocks` for that tenant. The AI system prompt is assembled from the tenant's enabled `tenant_prompt_blocks` + `ai_configs` fields. Tenants can customize block content; platform-locked blocks can be force-synced by admins.

### AI configuration per tenant

- `ai_configs.is_active` — global AI on/off for the tenant
- `channels.ai_enabled` — per-channel on/off
- `conversations.ai_paused` — per-conversation pause
- `ai_configs.custom_model_id` — optional fine-tuned model override (chat only, not vision)
- After a human sends a message: `conversations.human_override_until` is set for ~10 minutes (configurable `HUMAN_HOLD_MINUTES`), then AI can resume

---

## 8. Billing & Commission Logic

### Order commissions (5%)

- Triggered when AI creates a draft order and `hasHumanParticipationInCurrentOrderWindow()` returns false
- `orders.is_commissionable = true`, `commission_amount = total_price * 0.05`
- Commission is only realized on orders with status `confirmed`, `processing`, `shipped`, or `delivered`
- When an admin marks a report `billed` or `paid`, `orders.commission_status` is synced accordingly via `billingReportSyncService`

### AI use case fees (tiered)

- Recorded when a conversation is closed/resolved and all conditions pass: no human ever replied (`conversations.human_replied = false`), no `ai_paused`, no `human_override_until`, at least 1 AI message, no confirmed order
- Fee amounts are **not** stamped at creation — they are stamped by the **monthly billing snapshot job** (cron: `5 0 1 * *` — 1st of month, 00:05 UTC)
- Progressive tier pricing applied to each tenant's monthly volume:
  - 0–250 cases/month → €0.50/case
  - 251–500 → €0.40/case
  - 501–1000 → €0.30/case
  - 1000+ → €0.20/case
- Volume resets on the 1st of each month
- `ai_use_cases.billing_status`: `unbilled` → `billed` → `paid`

### Commission reports

- One row per tenant per billing period in `commission_reports`
- Aggregates: AI order commissions + use-case fees
- Admin-generated via the platform admin portal
- Status transitions (`unpaid` → `billed` → `paid`) cascade to underlying `orders.commission_status` and `ai_use_cases.billing_status` via `billingReportSyncService`

### Credits dashboard (tenant-facing)

- `/api/credits/summary` — current-month commission owed + use-case fees + estimated invoice
- `/api/credits/tier-status` — current use-case tier, count, projected fee, next tier threshold
- No prepaid credit wallet — "Credits" is purely a billing/invoice view computed at read time

---

## 9. Key Conventions

### Naming

| Area | Convention |
|------|-----------|
| Backend files | camelCase (functions/services); PascalCase (service classes) |
| DB column names | snake_case |
| Frontend component/page files | PascalCase (e.g. `ProductsPage.tsx`) |
| Frontend hooks/lib | camelCase (e.g. `useAuth.ts`, `api.ts`) |
| API modules | camelCase + `Api` suffix (e.g. `productsApi.ts`) |
| URL routes | kebab-case (e.g. `/ai-alerts`, `/chatbot-control`) |
| Controller actions | REST-ish names: `index`, `show`, `store`, `update`, `destroy` |

### TypeScript

- Backend shared types: `backend/src/types/index.ts`
- Domain types alongside data access: `db/models/*.ts` interfaces
- Validator types: `z.infer<typeof schema>` exported from `validators/*.ts`
- Frontend shared types: `frontend/src/types/index.ts`
- Backend uses snake_case; frontend types use camelCase — normalization happens in `frontend/src/api/*.ts` modules

### Environment variables

- Loaded via `dotenv/config` in `bootstrap.ts` before any app imports
- Validated at boot by `config/validateEnv.ts` (required: `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `OPENAI_API_KEY`)
- Accessed as `process.env.VAR_NAME` throughout — no typed config wrapper object
- Frontend: `import.meta.env.VITE_*`

### Error handling

- Per-controller `try/catch` → `sendError(res, message, statusCode, err)`
- Global fallback error handler in `middleware/errorHandler.ts` (registered last in `app.ts`)
- Sentry wired via `setupSentryExpressErrorHandler(app)` before global handler
- No widespread custom error class hierarchy (one exception: `OutboundChannelRateLimitedError`)

### Soft deletes

Products use soft delete (`deleted_at` timestamp). A partial unique index enforces name uniqueness only among non-deleted products: `(tenant_id, LOWER(TRIM(name))) WHERE deleted_at IS NULL`.

---

## 10. Key Environment Variables

### Backend (`backend/.env`)

**Required (app won't start without these)**

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Access token signing |
| `JWT_REFRESH_SECRET` | Refresh token signing |
| `OPENAI_API_KEY` | OpenAI API authentication |

**AI models and tuning**

| Variable | Purpose |
|----------|---------|
| `OPENAI_CHAT_MODEL` | Main chat model (e.g. `gpt-4o`) |
| `OPENAI_VISION_MODEL` | Vision/image analysis model |
| `OPENAI_EMBEDDING_MODEL` | Embedding model. Deployed value is `text-embedding-3-small` (1536-dim), which matches the `vector(1536)` column. ⚠️ The code fallback default in `openaiClient.ts` is `text-embedding-3-large` (3072-dim) — incompatible with the column, so this env var must stay set to a 1536-dim model. |
| `OPENAI_INTENT_MODEL` | Purchase intent detection model |
| `OPENAI_EVAL_MODEL` | Reply quality evaluation model |
| `OPENAI_FINETUNING_BASE_MODEL` | Base model for fine-tuning jobs |
| `SIMILARITY_THRESHOLD` | Cosine similarity threshold for product retrieval (default `0.65`) |
| `QUALITY_THRESHOLD` | Quality eval alert floor (default `0.1`) |
| `INTENT_THRESHOLD` | Min intent score to trigger draft order (default `0.85`) |
| `COMMISSION_SESSION_GAP_HOURS` | Session boundary for commission eligibility (default `3`) |
| `HUMAN_HOLD_MINUTES` | How long AI holds after a human reply |
| `AI_MAX_REPLIES_PER_HOUR` | Per-conversation AI rate limit (default `25`) |
| `AI_HISTORY_FETCH_LIMIT` | Messages loaded for AI context (default `40`) |

**Auth and security**

| Variable | Purpose |
|----------|---------|
| `ADMIN_JWT_SECRET` | Platform admin JWT signing |
| `ADMIN_KEY` | Bull Board / admin API key |
| `ENCRYPTION_KEY` | AES key for channel token encryption |

**Infrastructure**

| Variable | Purpose |
|----------|---------|
| `REDIS_URL` | Redis connection |
| `PORT` | API listen port (default `8000`) |
| `FRONTEND_URL` | CORS + OAuth redirect origin |
| `BACKEND_URL` | Public API base URL |
| `SENTRY_DSN` | Error reporting |

**Meta channels**

| Variable | Purpose |
|----------|---------|
| `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI` | Facebook OAuth |
| `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `INSTAGRAM_REDIRECT_URI` | Instagram OAuth |
| `WEBHOOK_VERIFY_TOKEN` | Meta webhook verification token |
| `WHATSAPP_BUSINESS_ID` | Partner Business Portfolio ID |
| `WHATSAPP_CONFIGURATION_ID` | WhatsApp Embedded Signup config |

**Storage**

| Variable | Purpose |
|----------|---------|
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Cloudinary image storage |
| `BACKBLAZE_ENDPOINT`, `BACKBLAZE_BUCKET_NAME`, `BACKBLAZE_KEY_ID`, `BACKBLAZE_APP_KEY`, `BACKBLAZE_PUBLIC_URL` | Backblaze B2 file storage |

### Frontend (`frontend/.env`)

| Variable | Purpose |
|----------|---------|
| `VITE_API_URL` | Backend API base URL (include `/api`) |
| `VITE_WS_URL` | WebSocket origin (no path) |
| `VITE_META_APP_ID` | Meta JS SDK app ID for WhatsApp Embedded Signup |
| `VITE_WHATSAPP_CONFIGURATION_ID` | Embedded Signup configuration ID |

---

## 11. Things to Know Before Changing Code

- **No ORM.** All SQL is raw and parameterized. Changes to the data model require a new numbered migration file in `backend/src/db/migrations/` and corresponding updates to `db/models/*.ts` interfaces and query functions.
- **`tenant_id` on everything.** Any new table that stores business data must include `tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE` and be scoped in every query.
- **Commission eligibility is decided at draft-order creation, not at confirmation.** The logic lives in `processAIReply.ts` → `hasHumanParticipationInCurrentOrderWindow()`. Be careful: `conversations.human_replied` (sticky, ever) disqualifies use cases; the session-window check (based on `COMMISSION_SESSION_GAP_HOURS`) is what governs order commissions.
- **Use cases and order commissions are mutually exclusive.** When a commissionable order is confirmed on a conversation that has an unbilled use case, the use case is voided. Never both.
- **Use-case fee amounts are not stamped at creation.** They are `null` until the monthly snapshot job runs on the 1st of the month. Queries on `fee_amount` before month-end will see nulls.
- **Channel disconnection preserves history.** `channel_id` on `contacts` and `conversations` is set to NULL when a channel is deleted (not CASCADE). Do not assume `channel_id` is always present.
- **Products are soft-deleted** (`deleted_at`). Never hard-delete products — orders denormalize `product_name` and set `product_id` to NULL via SET NULL, not CASCADE.
- **AI models are configurable per role.** There are separate env vars for chat, vision, embedding, intent detection, and quality evaluation — and a per-tenant `custom_model_id` for fine-tuned chat models. Never hardcode model names.
- **The AI pipeline has strict ordering.** Post-reply guards (hallucination filters, quality eval, knowledge gap detection) run after `generateReply()` but before the message is sent. Changing their order can affect billing (e.g. if a reply is blocked, no `ai_reply_sent` event fires and the use-case eval job may not be enqueued).
- **Bull Board** is accessible at `/api/admin/queues` with the `X-Admin-Key` header, not with the admin JWT.
- **Frontend normalizes snake_case → camelCase.** Backend returns snake_case JSON; `frontend/src/api/*.ts` modules normalize to camelCase TypeScript types. If adding a new API field, update both the response and the normalizer function.
