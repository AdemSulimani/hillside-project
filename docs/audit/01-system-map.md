# Phase 1 — System Map

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts). Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md for verbatim query evidence.

## 1. Architecture overview

Hillside is a single-process Node/Express monolith: HTTP API, Socket.IO server, and all five BullMQ workers run in one Node process (backend/src/server.ts:5-11, 17-18). Inbound customer messages arrive as channel webhooks (Meta Graph API for Facebook/Instagram/WhatsApp, Viber API) at `POST /api/webhooks/*` (backend/src/app.ts:142), flow through the `webhook` queue into `processInboundMessage`, which enqueues `ai.reply` on the `ai` queue; `processAIReply` (backend/src/jobs/processAIReply.ts, 3,847 lines) is the orchestrator for the entire AI pipeline. PostgreSQL 16 with pgvector is the only database (raw `pg`, no ORM); Redis serves as cache, BullMQ backing store, lock/rate-limit/idempotency store, and Socket.IO adapter. Production runs on one DigitalOcean droplet (1 vCPU / 2 GB RAM) via Docker Compose (docker-compose.prod.yml:1).

```
End customer ──(Messenger/IG/WhatsApp/Viber)──▶ Meta/Viber ──webhook──▶ Express /api/webhooks
                                                                            │ enqueue
                                                                       BullMQ `webhook` queue ── processInboundMessage
                                                                            │ enqueue ai.reply (delay 8s)
Browser (React SPA) ◀──Socket.IO room tenant:{id}──┐                   BullMQ `ai` queue ── processAIReply
        │ REST /api/*                              │                        │
        ▼                                          │              ┌─────────┼──────────┬───────────────┐
     Express ──────────────────────────── socketService ◀── emits │         │          │               │
                                                             PostgreSQL   Redis     OpenAI       channel send APIs
                                                             (pgvector)  (locks,   (chat/intent/ (Graph API, Viber)
                                                                          counters, eval/vision/
                                                                          idem keys) embedding)
```

### Component responsibilities

| Component | Responsibility | Key files |
|---|---|---|
| Express app | Route mounting (21 namespaces under `/api`, backend/src/app.ts:132-152), helmet/CORS/compression, three rate-limit tiers (app.ts:78-120), raw-body capture for webhook signatures (app.ts:122-128), Bull Board mount (app.ts:154), Sentry + global error handler last (app.ts:156-158) | backend/src/app.ts |
| HTTP server / process | Hosts Express + Socket.IO + all 5 BullMQ workers in one process; graceful SIGTERM drain (25 s default) | backend/src/server.ts:5-24, 41-81 |
| Webhook ingestion | Meta GET handshake, HMAC-SHA256 signature verification, 300 s timestamp skew gate, Redis edge dedupe, 200-then-enqueue | backend/src/controllers/webhookController.ts, viberWebhookController.ts, webhookVerificationController.ts |
| Webhook normalization | Per-channel payload → `InboundMessageDTO`/`InboundEditDTO`; echo/reaction/sticker/edit handling | backend/src/services/webhookNormalizer.ts (singleton export at line 1337) |
| Inbound processor | Tenant/channel resolution, contact/conversation upsert, attachment re-hosting (Cloudinary/Backblaze), echo classification, AI job enqueue with 8 s delay + debounce | backend/src/jobs/processInboundMessage.ts:428-908 |
| AI reply orchestrator | Concurrency controls, enablement gates, burst merge, pre-reply special paths, `generateReply`, post-reply guard chain, send, persist, draft-order creation | backend/src/jobs/processAIReply.ts |
| Reply generation | System-prompt assembly, fusion retrieval (RRF), history windowing/truncation, single main `chat.completions.create` (max_tokens 768, temp 0.3 default) | backend/src/services/aiService.ts:3446-4145, 4118-4124 |
| Classifiers | 33 `chat.completions.create` call sites besides the main reply (intent, guards, routing) — all temp 0, `json_object` | backend/src/services/aiService.ts, intentDetectionService.ts, aiQualityService.ts, productAttribute*/productInformationGap*, productImageMatchingService.ts |
| Retrieval / embeddings | 4-source weighted RRF fusion, pgvector HNSW similarity, trigram ILIKE, embedding jobs + reconcile crons | backend/src/services/aiService.ts:677-762, embeddingService.ts, backend/src/db/models/product.ts:759-815, backend/src/jobs/reconcileProductEmbeddings.ts |
| Prompt assembly | Tenant prompt-block fork/sync, `{{TOKEN}}` expansion, runtime appends, restrictions footer | backend/src/services/promptAssemblyService.ts, backend/src/db/models/promptBlock.ts, aiService.ts:2249-2298, 3919-4092 |
| Outbound delivery | Per-channel senders (Graph API v25.0, Viber chatapi), per-channel token bucket, send idempotency markers | backend/src/services/channelSenderService.ts, outboundChannelRateLimiter.ts |
| Data-access layer | 18 raw-SQL model files over a shared pool; 69 numbered migrations (two share prefix 062) | backend/src/db/models/*.ts, backend/src/db/pool.ts, backend/src/db/migrations/ |
| Real-time | Socket.IO with Redis adapter, JWT handshake, room `tenant:{tenantId}`, 8 event types | backend/src/sockets/index.ts:27-69, backend/src/services/socketService.ts:35-93 |
| Jobs / crons | 5 queues, 5 workers, 7 registered schedulers, failure handler with prod webhook alert | backend/src/jobs/workers.ts, queues/*, failureHandler.ts |
| Billing | Draft-order commission decision, use-case evaluation (4 h delayed job), monthly snapshot | backend/src/jobs/processAIReply.ts:3510-3837, evaluateConversationUseCase.ts, monthlyUseCaseSnapshot.ts, backend/src/services/aiUseCaseService.ts |
| Frontend | React 19 + Vite SPA; CRM inbox, AI kill switches (global/channel/conversation), AI alerts, feedback corrections; TanStack Query cache patched from socket events | frontend/src/pages/*, frontend/src/hooks/useRealtimeInbox.ts, frontend/src/contexts/CrmSocketContext.tsx |
| Platform admin | Separate JWT (`ADMIN_JWT_SECRET`), tenant AI-config/prompt-block management, commission reports | backend/src/controllers/adminAiController.ts, adminCommissionController.ts, backend/src/middleware/authenticateAdmin.ts |

Auth boundaries: business-user JWT (`authenticate`, backend/src/middleware/authenticate.ts:16-33), platform-admin JWT (`authenticateAdmin`, backend/src/middleware/authenticateAdmin.ts:17-48), Bull Board `X-Admin-Key` with timing-safe compare (backend/src/middleware/requireAdminKey.ts:4-32), and webhooks authenticated by HMAC signature + channel resolution, no JWT (backend/src/app.ts:84-93).

## 2. Dependency graph

Textual graph (component → depends on):

```
frontend SPA (React/Vite)
  → Express REST /api/* (axios, Bearer JWT + single-flight refresh)
  → Socket.IO server (JWT in handshake.auth.token; room tenant:{tenantId})   [sockets/index.ts:42-69]

Express app (backend/src/app.ts)
  → routes → middleware (authenticate / ensureOnboarded / authenticateAdmin / requireAdminKey)
  → controllers → services + db/models
  → webhook queue (webhookController.ts:234-248 enqueue after res.sendStatus(200))
  → PostgreSQL (db/pool.ts — single Pool, PG_POOL_MAX default 10)
  → Redis redisConnection (jobs/redisConnection.ts:7 — cache, dedupe, rate limits)
  → Sentry (instrument.ts), Bull Board (jobs/bullBoard.ts:14 at /admin/queues)

BullMQ queues (webhook, ai, notifications, finetuning, default)
  → sharedQueueConnection (jobs/queue.ts:9 — one ioredis for all Queue instances)

Workers (webhookWorker, aiWorker, notificationsWorker, finetuningWorker, defaultWorker)
  → own ioredis connection each (workers.ts:55-57, maxRetriesPerRequest: null)
  → run inside the API process (server.ts:5-11)

processInboundMessage (webhook queue)
  → webhookNormalizer.ts (normalizeEvent)
  → PostgreSQL (channel resolution, contact/conversation upsert, message insert)
  → Meta Graph API v25.0 (profile lookups, media resolution — processInboundMessage.ts:46-47)
  → Cloudinary (images) / Backblaze B2 (audio/docs) for attachment re-hosting (processInboundMessage.ts:672-686)
  → ai queue (aiQueue.add('ai.reply', …, { delay: AI_REPLY_DELAY_MS }) — processInboundMessage.ts:886-907)
  → Redis (webhook_seen dedupe read upstream; self_send_echo registry)
  → socketService (new_message, conversation_updated, message_edited)

processAIReply (ai queue)
  → Redis (ai_active_jobs:{tenantId}, ai_conv_lock:{conversationId}, ai_rate_limit:{conversationId},
           ai_send_done:…, ai_img_sent:… — processAIReply.ts:1153-1236, 3057-3180)
  → PostgreSQL (gates, history, alerts, outbound message, draft orders)
  → aiService.generateReply
      → Redis prompt caches (ai_config:, tenant_prompt_blocks:, tenant:, products: — aiService.ts:201-306)
      → embeddingService → OpenAI embeddings.create (embeddingService.ts:12)
      → db/models/product.ts pgvector HNSW search (product.ts:759-815)
      → openaiClient singleton → OpenAI chat.completions.create (openaiClient.ts:25-29; main call aiService.ts:4118)
  → ~33 classifier LLM call sites (see §5) → OpenAI
  → channelSenderService → Graph API / Viber API (channelSenderService.ts:32-150)
      → outboundChannelRateLimiter (Redis token bucket rate:outbound:channel:{id})
      → cryptoService.decrypt(access_token_encrypted)
  → socketService → Socket.IO → Redis adapter → browser
  → ai queue (delayed evaluateConversationUseCase, jobId eval-usecase-{conversationId} — processAIReply.ts:3461-3470)

default queue jobs (product.embedding, product.imageFingerprint, reconciles, refreshMetaTokens, monthlyUseCaseSnapshot)
  → OpenAI (embeddings, vision fingerprints), PostgreSQL, Meta Graph API (token refresh)

finetuning queue → OpenAI files/fine-tuning APIs (prepareFinetuning.ts:193-197, checkFinetuningStatus.ts:17-22)

notifications queue → no producers; processor is a no-op placeholder (processNotificationJob.ts:4-12)

socketService → Socket.IO → @socket.io/redis-adapter (two dedicated ioredis clients, sockets/index.ts:27-39)
failureHandler → ALERT_WEBHOOK_URL via axios in production (failureHandler.ts:34-49) — not via the notifications queue
```

## 3. Request flow

End-to-end flow of one inbound customer message to an outbound AI reply (worst-case full path):

1. **Platform → webhook**: Meta/Viber POSTs to `/api/webhooks/:channelType` or `/api/webhooks/viber/:channelId` (backend/src/routes/webhooks.ts:8-15); routes exempt from rate limiting (app.ts:84-93); raw body captured (app.ts:122-128).
2. **Verification**: HMAC-SHA256 over raw body vs `X-Hub-Signature-256` (Meta, webhookController.ts:271-282) or per-bot decrypted token vs `X-Viber-Content-Signature` (viberWebhookController.ts:147-165); timestamp skew ≤300 s from body timestamp, falls back to `Date.now()` when absent (webhookController.ts:302-307).
3. **Edge dedupe**: Redis `SET webhook_seen:{messageId} NX EX 86400` (webhookController.ts:309-315); duplicate → 200, no enqueue.
4. **200-then-enqueue**: `res.sendStatus(200)` then `webhook` queue add with a freshly minted `traceId` (webhookController.ts:335-336, 238); enqueue failure after 200 is only logged (webhookController.ts:245-247).
5. **webhookWorker** (concurrency default 10, prod overlay 3 — workers.ts:71, docker-compose.prod.yml:66) runs `processInboundMessage`: normalize → global DB dedupe on `external_message_id` (processInboundMessage.ts:465-472) → channel/tenant resolution by `(type, external_id)` (474-488; miss → throw → 3 attempts, fixed 5 s backoff — webhookQueue.ts:10-14) → contact/conversation upsert → attachment download + re-host → echo branches → inbound message persist → sockets.
6. **AI job enqueue with delay + debounce**: removes at most one pending `ai.reply` for the same conversation, then adds a new one with `delay: AI_REPLY_DELAY_MS` default **8000 ms** (processInboundMessage.ts:886-907). Skipped when `skipAiReply === true` (reactions/stickers).
7. **aiWorker** (concurrency default 5, prod 2 — workers.ts:72, docker-compose.prod.yml:67; ai queue: 3 attempts, exponential from 10 s — aiQueue.ts:10-14) dispatches to `processAIReply`.
8. **Per-tenant fairness slot**: Redis `INCR ai_active_jobs:{tenantId}` (TTL 300 s); over `AI_MAX_CONCURRENT_PER_TENANT` (default 8) → re-enqueue self with **+3 s delay** and return (processAIReply.ts:1152-1180).
9. **Per-conversation lock**: `SET ai_conv_lock:{conversationId} <uuid> PX 300000 NX`; busy → re-enqueue **+3 s**, return (processAIReply.ts:1197-1213). Released token-checked via Lua in `finally` (1141-1146, 3839-3846).
10. **Per-conversation rate limit**: atomic Lua INCR+EXPIRE on `ai_rate_limit:{conversationId}` (TTL 3600 s); over `AI_MAX_REPLIES_PER_HOUR` (default 25) → pause AI + `rate_limit_exceeded` alert, return (processAIReply.ts:1226-1294). Counter increments per job attempt, before the gates (1231).
11. **Enablement gates**: `ai_configs.is_active` → `channels.ai_enabled` → conversation exists / `ai_paused` / `human_override_until` (processAIReply.ts:1296-1336). Active human hold → job rescheduled to fire `remainingMs + 5000 ms` after hold expiry (430-476; hold default 10 min, conversationService.ts:343).
12. **History + burst merge**: load last 40 messages (1338); merge up to the last 5 consecutive inbound messages since the last outbound, deduped at Jaccard ≥0.82 (300-341). Staleness guard: exit if a newer inbound superseded this job (1345-1352); skip reactions/emoji-only/empty (1354-1367).
13. **Language detection** (LLM, 1373) → locale `sq`/`en` threads through all canned messages.
14. **Pre-reply special paths** (single fail-open try/catch, 1942-1948; every send preceded by `shouldStillSendAutomatedReply` re-validation, 351-414): cancellation/refund (conf >0.8 → canned ack + pause + alert, 1380-1501) → wrong-product (1503-1591) → delivery-ETA-only auto-reply (1642-1716, no pause/alert) → post-purchase support (1718-1808) → order-info update (conf >0.82 → direct order UPDATE + canned confirmation, 1809-1941). Each path returns; otherwise fall through.
15. **`generateReply`** (1957-1972; aiService.ts:3446-4145): prompt-cache loads → retrieval routing (persisted `product_ids` → anchors → RRF fusion search) → prompt assembly → main completion (aiService.ts:4118-4124). Can return `[NO_REPLY]` → silent exit (processAIReply.ts:1983-1985).
16. **Post-reply guard chain** (in code order, each replacing/editing `finalReplyText` before send): usage-question guards → product-information gap → speculative health advice → order-confirmation formatting → data-confirmation/missing-name overrides → repeated-closing and follow-up-invitation strips → quality evaluation (eval model) → price-hallucination guard (deterministic) → product-name-hallucination guard (LLM) → uncertain-answer fallback → contradictory-notice strip → outbound sanitizer → product-image-request override (processAIReply.ts:2004-3049). Escalating guards pause AI and substitute a holding message but never abort the send.
17. **Send**: idempotency marker `ai_send_done:{conversationId}:{messageExternalId}` EX 3600 checked/written around `sendMessage` (3057-3108); precheck bypassed for knowledge-gap escalations (3070-3077); per-channel Redis token bucket with up to 60 s wait (outboundChannelRateLimiter.ts:61-98). Send failures return `{ success: false }` — never thrown (channelSenderService.ts:319-327).
18. **Persist + post-send effects**: outbound message row with `quality_score`/`flagged`/`product_ids` (3189-3212) → post-persist alert transactions (hallucinated_price / hallucinated_product_name / uncertain_answer_escalated / quality flag, each + pause, 3255-3444) → `touchConversationLastMessageAt` → `ai_reply_sent` analytics → sockets → **delayed 4 h `evaluateConversationUseCase` enqueue**, `jobId: eval-usecase-{conversationId}` (3446-3470). Send failure marks the row failed + `message_send_failed` alert (3472-3508).
19. **Draft-order block** (own swallowing try/catch, 3510-3837): intent detection (intent model) → validation gate (`is_ready_to_order && intent_score > 0.85 && product_name && address && phone && name && affirmation`, 3605-3612) → deterministic product resolution (ambiguous → one-time variant-clarification message, 3667-3717) → duplicate-order guards (3755-3786) → commission decision via `hasHumanParticipationInCurrentOrderWindow` (session gap 3 h default, 501-541) → `createOrder(status: 'draft', detected_by: 'ai')` + socket (3803-3830).
20. **finally**: release conversation lock, then tenant slot (3839-3846).
21. **Browser**: `CrmSocketContext`/`useRealtimeInbox` receive `new_message`/`conversation_updated`/`ai_alert`/`order_created` in room `tenant:{tenantId}` and patch the TanStack Query cache (frontend/src/hooks/useRealtimeInbox.ts:232-235).

Delays and queue hops in the happy path: webhook queue hop → 8 s AI delay → ai queue hop; optional +3 s fairness/lock re-delays; optional human-hold reschedule (~10 min); 4 h delayed billing-evaluation job.

## 4. Data flow

| Stage | Data in | Queries / calls | Data out |
|---|---|---|---|
| Webhook edge | Raw channel JSON + signature headers | Redis `SET NX` dedupe; channel `webhook_verified` UPDATE (webhookController.ts:284-300) | `{ channelType, payload, traceId }` job on `webhook` queue |
| Normalization | Raw payload | none (pure) | `InboundMessageDTO` (externalMessageId, contactExternalId, content, attachmentUrls, skipAiReply, isEcho — webhookNormalizer.ts:4-35). First-element-only: only `entry[0]/messages[0]` extracted (webhookNormalizer.ts:812-816) |
| Inbound persist | DTO | `SELECT id FROM messages WHERE external_message_id = $1` global dedupe (message.ts:290-298); channel lookup by `(type, external_id)` no tenant filter (channel.ts:119-128); contact/conversation upserts; Graph media fetch → Cloudinary/Backblaze uploads | `messages` row (`direction: inbound, sent_by: customer`); `ai.reply` job |
| Gating | Job data | `findAIConfigByTenant`, `findChannelById`, `findConversationById` — DB reads, not cache (processAIReply.ts:1296-1336) | proceed / silent exit / reschedule |
| History load | conversationId | `SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 40` re-sorted ASC (message.ts:304-321) — **no filter on flagged/quality/send_status/tenant** | 40-message window; last 10 raw + deterministic summary of the older 30 (aiService.ts:3476-3484, 3049-3090) |
| Prompt-config load | tenantId | Redis read-aside: `ai_config:` (900 s), `tenant_prompt_blocks:` (900 s), `tenant:` (1800 s), `products:` (120 s) → DB on miss (aiService.ts:201-306); `forceSyncLockedBlocksForTenant` UPDATE on every reply (aiService.ts:239-251) | ai_config, tenant, prompt blocks, fallback catalog |
| Retrieval | Merged burst text (up to 5 messages joined by `\n`) | Query embedding (`embeddings.create`, 5 s race, 256-entry in-process cache — aiService.ts:650-664, 614-644); pgvector cosine SQL with `SET LOCAL hnsw.ef_search` 100→500 adaptive retry (product.ts:759-815); trigram ILIKE keyword/phrase/category searches (product.ts:510-715); RRF fusion weights 2.0/1.5/1.2/1.0, semantic dropped entirely on category-shopping intent (aiService.ts:723-736) | ≤10 matched products (25 on category turns), similarity ≥ `SIMILARITY_THRESHOLD` 0.65 applied in JS (aiService.ts:703-709) |
| Prompt assembly | tenant + config + blocks + products + history | pure string assembly; system prompt ≈6,500–8,300 tokens typical, ≈10,000+ on category turns (prompt mapper measurement over live blocks); history budget 6,000 tokens via chars/4 estimator, system prompt excluded from budget (aiService.ts:4003-4038, 129-131) | `messages[]` array: system prompt, optional summary system message, ≤10 raw turns, current inbound (+`image_url` parts) |
| Generation | messages[] | `openai.chat.completions.create({ model, temperature: 0.3 default, max_tokens: 768 })` (aiService.ts:4118-4124); no seed/top_p/response_format on the main call | reply text + `matchedProducts` + flags |
| Classifiers/guards | inbound text and/or draft reply | up to ~28–33 distinct OpenAI calls on the worst-case text path, plus per-assistant-message order-closing scans (orchestration mapper §5; processAIReply.ts:740-751 loops an LLM call over history, invoked twice per job); vision adds ~10–15 calls per image burst | mutated `finalReplyText`, escalation flags, alerts |
| Send | finalReplyText | Graph API v25.0 / Viber `send_message` (channelSenderService.ts:32-150); Redis token bucket; idempotency markers | channel message id (WhatsApp returns null — channelSenderService.ts:118) |
| Persist/analytics | reply + metadata | `createMessage` with `product_ids` (emptied on escalations — processAIReply.ts:3189-3211); alert INSERTs in own transactions; `analytics_events` INSERT `ai_reply_sent` (fires even on send failure — 3448 precedes 3472) | outbound `messages` row, `ai_alerts` rows, socket events |
| Draft order | last-40 history + catalog names | `detect()` (intent model, intentDetectionService.ts:135); deterministic `resolveOrderProduct`; commission SQL window over 30 days (processAIReply.ts:501-541) | `orders` row (`draft`, `is_commissionable`, `commission_amount` = 5% of `price × qty`; `discounted_price` not consulted — processAIReply.ts:3751-3795) |
| Billing eval | conversationId (4 h later) | `checkAndCreateUseCase` — no LLM (classifiers mapper: zero openai imports in evaluateConversationUseCase); billability: `human_replied=false`, `ai_paused=false`, `human_override_until IS NULL`, ≥1 AI message, no confirmed order (aiUseCaseService.ts:283-303) | `ai_use_cases` row (fee_amount NULL until monthly snapshot) |

## 5. AI model configuration

| Env var | Example (.env.example) | Code default | Used by |
|---|---|---|---|
| `OPENAI_CHAT_MODEL` | `gpt-4o-mini` (.env.example:15) | `'gpt-4o'` (openaiClient.ts:31); separate fallback `'gpt-4o-mini'` in AIProductProcessingService.ts:35 | Main text reply (unless `custom_model_id` set — aiService.ts:4106-4108); ~28 of the 33 classifier sites; product-import extraction |
| `OPENAI_VISION_MODEL` | `gpt-4o` | `'gpt-4o'` (openaiClient.ts:32) | Main reply when images present (overrides `custom_model_id`); customer-photo extraction, ambiguity re-rank, catalog fingerprint (productImageMatchingService.ts:275, 327; productImageFingerprintService.ts:121) |
| `OPENAI_EVAL_MODEL` | `gpt-4o` | `'gpt-4o'` (openaiClient.ts:33; re-read per call aiQualityService.ts:4-6) | Reply quality evaluation only (aiQualityService.ts:167) |
| `OPENAI_INTENT_MODEL` | `gpt-4o` | `'gpt-4o'` (openaiClient.ts:34; re-read per call intentDetectionService.ts:112) | Purchase-intent detection only (`detect`) — all other intent classifiers run on `OPENAI_CHAT_MODEL` |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` (.env.example:26) | `'text-embedding-3-large'` (openaiClient.ts:35-36; re-read per call embeddingService.ts:13) | Product embeddings, query embeddings, image-fingerprint embeddings. Code default emits 3072-dim vectors; schema columns are `vector(1536)` (migrations 029:4, 047:12); no `dimensions` param passed (embeddingService.ts:12-15) — only the .env.example value is schema-compatible |
| `OPENAI_FINETUNING_BASE_MODEL` | `gpt-4o-mini-2024-07-18` | `'gpt-4o-mini-2024-07-18'` (openaiClient.ts:37-38) | Fine-tuning jobs (prepareFinetuning.ts:197) |
| `ai_configs.custom_model_id` (per tenant, DB) | — | `null` (aiService.ts:198) | Main text reply and admin sandbox test only (aiService.ts:4108, adminAiController.ts:340); never classifiers, never vision |
| `OPENAI_MAX_RETRIES` / `OPENAI_TIMEOUT_MS` | — (absent) | 3 / 60,000 ms (openaiClient.ts:15-23) | Shared client resilience; bypassed by AIProductProcessingService's own `new OpenAI({ apiKey })` (AIProductProcessingService.ts:34) |
| `AI_REPLY_TEMPERATURE` | — (absent) | 0.3, clamped [0,2]; capped ≤0.3 on uncertain image turns (aiService.ts:122-126, 4113-4116) | Main reply. All 33 classifier sites use temperature 0 except the admin sandbox test (0.7, adminAiController.ts:347) |

Sampling/params on the main call: `max_tokens: 768`, no `response_format`/`seed`/`top_p` (aiService.ts:4118-4124). Every classifier uses `response_format: { type: 'json_object' }`; none uses structured outputs, tool calling, seed, or logprobs (classifiers mapper, uniformity observations).

## 6. Memory systems

**Short-term context (history window).** `findMessagesByConversation(conversationId, 40)` (`AI_HISTORY_FETCH_LIMIT` default 40 — aiService.ts:108-112; SQL at message.ts:304-321, no filter on flagged/quality/send_status). The last 10 messages enter the prompt raw (`RECENT_RAW_HISTORY_MESSAGES = 10`, aiService.ts:98); the older ≤30 are compressed into a deterministic, lossy string-statistics summary — no LLM (aiService.ts:3049-3090) — injected as a second system message (aiService.ts:3104-3113). A 6,000-token budget (chars/4 estimator) trims the raw window down to a floor of 3 messages; the system prompt and inbound message are excluded from the budget (aiService.ts:4003-4038). Human-agent and AI outbound turns are both mapped to role `assistant`, indistinguishable to the model (aiService.ts:3117-3118). Flagged/low-quality/failed-send messages re-enter context unfiltered (prompt mapper §d).

**Session memory (product anchors).** Every outbound AI message persists `messages.product_ids` (JSONB, migration 062_message_product_context.sql:22-23) — the catalog products the reply referenced; emptied when the reply was a holding/escalation message (processAIReply.ts:3189-3211). Follow-up turns reuse them deterministically: `collectRecentlyDiscussedProductIds` takes the most recent AI message with non-empty `product_ids` (message.ts:183-191), rehydrated tenant-scoped and active-only (product.ts:285-308). Migration 062's header documents the rationale: re-deriving products from raw text each turn "is inherently fragile" (062_message_product_context.sql:11-14). Conversation anchors (regex scan of the last 10 messages) and burst merging (last 5 inbound, Jaccard 0.82 dedupe) supplement this (productRetrievalService.ts:209-250; processAIReply.ts:300-341).

**Long-term memory: none.** No message, conversation, document, or tool-output embeddings exist (retrieval mapper §5.2); no semantic conversation memory, no user profiles beyond `contacts` metadata (phone, name). The only cross-conversation state is DB rows (orders, alerts, contact metadata).

**Control state on conversations.** `ai_paused` (manual or guard-set pause), `human_replied` (sticky flag — set by human replies, actively **reset to false** by most escalation guards, e.g. processAIReply.ts:2026, 3358), `human_override_until` (~10 min hold after any human reply, re-extended per reply — conversationService.ts:343-367), `fully_ai_handled` (set at commissionable order confirm — order.ts:509-511). Redis-side control state: fairness counter, conversation lock, hourly rate counter, send/image idempotency markers, self-sent-echo registry (caching-config mapper §A.2, A.4).

## 7. Vector database storage policy audit

The only vector store is pgvector inside the primary PostgreSQL; no external vector DB (retrieval mapper §5.2).

**Entities embedded (exactly two, confirmed by exhaustive `generateEmbedding(` call-site search):**

| Entity | Column | Dim | Written by |
|---|---|---|---|
| `products` | `embedding vector(1536)` (migration 029:4) | 1536 | `product.embedding` BullMQ job (generateProductEmbedding.ts:54-64) |
| `product_image_fingerprints` | `embedding vector(1536)` (migration 047:12) | 1536 | `product.imageFingerprint` job (productImageFingerprintService.ts:185-197) |

Two additional query-time-only vectors are never persisted: the customer-message query embedding (aiService.ts:656, in-process 256-entry cache only) and the customer-photo fingerprint-text embedding (productImageMatchingService.ts:592, not cached as a vector).

**Entities excluded, with in-code reasoning where visible:** `messages` and `conversations` carry no vector columns — follow-up resolution deliberately uses persisted `product_ids` instead ("Unlike the text-based resolvers it cannot be defeated by … embedding gaps, or by semantic-search timeouts", aiService.ts:798-808; migration 062 header). Uploaded documents (PDF/spreadsheet/OCR) are never vectorized (zero embed references in backend/src/services/documents/); they are parsed into structured `products` rows and it is those rows that get embedded — raw `extracted_text` is stored on the product and used in prompts via `sanitizeExtractedText` (productRetrievalService.ts:615-627) but excluded from the embedded blob. Classifier/tool outputs, AI replies, quality evals, `ai_configs`, prompt blocks, orders, and contacts have no persistence-to-vector path.

**Storage/indexing/retrieval of products.** One embedding per product over a single concatenated blob from `buildProductText` (brand, name, category, structured attributes, description, usage_description, tags — embeddingService.ts:35-63); **no chunking, no length cap, no token-budget truncation, no text normalization** on either the document or query side (lexical paths do normalize — aiService.ts:332-350). HNSW indexes are **global across tenants** with `tenant_id` as a post-ANN WHERE filter (migrations 029:6-8, 047:23-25; product.ts:721-729 documents the "right product exists but wasn't retrieved" recall bug this creates for small tenants); compensated by adaptive `hnsw.ef_search` 100 → one retry at 500 when the first pass under-fills (product.ts:730-749, 804-814). Similarity floor 0.65 is applied in JS post-SQL for products (aiService.ts:703-709) but in-SQL for fingerprints (productImageFingerprint.ts:292) — two conventions in one codebase.

**Filtering before embedding.** Embedded rows must be `deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL` plus a model guard `(embedding_model IS NULL OR embedding_model = $4)` treating NULL-model legacy rows as compatible (product.ts:771-788). Filtering is at query time; embedding jobs themselves embed whatever active product text exists.

**Dedup.** One name = one row = one vector per tenant via partial unique index `(tenant_id, LOWER(TRIM(name))) WHERE deleted_at IS NULL` (migration 046:36-38) and `upsertProductByName ON CONFLICT DO UPDATE` (product.ts:135-167). Fingerprints unique on `(tenant_id, image_url_hash)` with COALESCE-preserving upsert (047:17; productImageFingerprint.ts:156-166). Job-level dedup via BullMQ jobIds (`embed-fast-{id}`, `fp-fast-{urlHash}`); the slow fingerprint lane passes no jobId (reconcileProductImageFingerprints.ts:36-44). Vision extractions cached in Redis 7 days (catalog, tenant-namespaced key) / 1 hour (customer photos, full-content SHA-256) (productImageFingerprintService.ts:108-119; productImageMatchingService.ts:255-299).

**Retention / staleness.** Three-layer freshness: (1) synchronous invalidation — `updateProduct` NULLs `embedding` + `embedding_input_hash` whenever any of 11 embedding-relevant fields changes (product.ts:315-363); (2) 6-hour hash reconcile — recomputes SHA-256 of `buildProductText` output and re-queues rows where the hash differs, embedding is NULL, **or** `embedding_model` differs from the active model (reconcileProductEmbeddings.ts:78-175); (3) per-minute NULL fast lane + on-demand tenant self-heal at retrieval time (reconcileProductEmbeddings.ts:45-53, 228-261; triggered from aiService.ts:3740-3765). Fingerprint staleness uses a schema-version integer (`CURRENT_FINGERPRINT_VERSION = 2`, productImageFingerprint.ts:16). Soft-deleted products retain their vectors in-row but are excluded by search predicates and the partial HNSW index; fingerprints are hard-deleted on image replacement/product delete (productImageFingerprint.ts:202-234). Migration 029 destroyed all prior 768-dim vectors when re-creating the column at 1536 (029:3-4).

**Tool outputs.** All classifier JSON outputs are consumed in-flight and discarded; nothing from the guard chain, intent detection, or quality evaluation is embedded or persisted as vectors (retrieval mapper §5.2).

**Selective-embedding retrieval consistency (observation only).** Because only products are embedded, semantic retrieval sees a different corpus than lexical retrieval sees fields: ILIKE paths search 10 columns including `flavor/size/color/variant/weight` that lack trigram indexes (product.ts:510-536; migration 044 covers only name/brand/description/category/tags), while the semantic path searches the un-normalized `buildProductText` blob. Rows with NULL embeddings (new products, post-edit invalidation, model drift) are silently invisible to the semantic source but remain keyword-searchable (product.ts:358-359) — during the reconcile window the same query can return different product sets depending on which source fires, and the category-intent branch drops the semantic source entirely while still paying the embedding call (aiService.ts:688-736). Query embeddings that time out (5 s race, non-aborting) silently degrade the turn to lexical-only retrieval (aiService.ts:650-664).

## 8. Deployment architecture

**Compose topology.** Four services — `postgres` (pgvector/pgvector:pg16), `redis` (redis:7-alpine), `backend`, `frontend` (Nginx) — on one DigitalOcean droplet, 1 vCPU / 2 GB RAM (docker-compose.yml:16-101; docker-compose.prod.yml:1). One backend instance, no replicas; the Socket.IO Redis adapter is wired but fans out across a single instance (sockets/index.ts:39). Postgres/Redis bind to loopback only (docker-compose.yml:24, 55); host nginx terminates TLS for api./app.byhillside.com (docker-compose.prod.yml:9-11). Prod memory limits: postgres 640M, redis 224M (`--maxmemory 192mb --maxmemory-policy noeviction`, docker-compose.prod.yml:43-53 — `noeviction` required because BullMQ job state shares this Redis, rationale at docker-compose.yml:39-42; the base compose sets `noeviction` but no `maxmemory`), backend 900M (`--max-old-space-size=768`), frontend 96M (docker-compose.prod.yml:30-86). Worker concurrency is dialed down in prod: webhook 3, ai 2, others 1 (docker-compose.prod.yml:64-70) vs code defaults 10/5/3/3/1 (workers.ts:71-75).

**CI/CD.** CI (.github/workflows/ci.yml): backend typecheck+build; a migration + health smoke test that boots `dist/server.js` against service containers with a placeholder OpenAI key and polls `/api/health` (ci.yml:40-124, 80); frontend lint+build. **`npm test` never runs in CI** (verified; matches CLAUDE.md §4). Deploy (.github/workflows/deploy.yml): push to main → staging via Render/Vercel deploy hooks + health poll (deploy.yml:20-56); tag `v*` → production over SSH gated by the GitHub `production` environment (deploy.yml:58-117); env files arrive as base64 secrets; images build on the droplet itself (no registry, deploy.yml:77-78). `scripts/deploy.sh`: atomic env writes → `build` → **one-shot migration `run --rm backend node dist/db/migrate.js` before containers start** (deploy.sh:71-74) → `up -d --remove-orphans` → in-container health poll 30×5 s → image prune. No automated rollback, canary, or blue/green; rollback is a documented manual re-deploy of a prior tag (DEPLOYMENT.md:153-157).

**Startup.** Container CMD re-runs migrations at every boot (`node dist/db/migrate.js && node dist/server.js`, backend/Dockerfile:27 — migrations run twice per deploy). In-process order: `bootstrap.ts` (dotenv + `validateRequiredEnv` — hard-fails on missing DATABASE_URL/JWT secrets/OPENAI_API_KEY; production additionally enforces ≥32-char secrets and distinct JWT secrets, validateEnv.ts:38-89) → Sentry (instrument.ts) → Express app → **worker import starts all 5 workers and registers all 7 cron schedulers at module load** (server.ts:5-11; workers.ts:195-221) → Socket.IO attach → `listen` + Redis memory monitor (server.ts:17-24). Code fallback for PORT is 3000, not the documented 8000 (server.ts:15).

**Shutdown.** SIGTERM/SIGINT → stop HTTP → `worker.close()` on all five workers raced against `SHUTDOWN_TIMEOUT_MS` default 25,000 ms → `process.exit(0)` (server.ts:41-81). Neither compose file sets `stop_grace_period`, so Docker's default 10 s SIGTERM→SIGKILL window is shorter than the 25 s in-process budget; jobs killed mid-flight rely on BullMQ stall recovery (`maxStalledCount: 2`, workers.ts:46). The pool/Redis/Socket.IO are not closed explicitly. Scheduled crons: fine-tuning prep nightly 02:00 UTC, embedding reconcile 6 h + every-minute fast lane, fingerprint reconcile 6 h + 2-minute fast lane, Meta token refresh weekly, monthly use-case snapshot 00:05 UTC on the 1st (queueing mapper §7).

## 9. Documented-vs-actual discrepancies observed during mapping

| # | Documented claim (CLAUDE.md / .env.example / in-code comment) | Actual behavior (evidence) |
|---|---|---|
| 1 | CLAUDE.md §5 names the normalizer singleton `webhookNormalizerService`; audit tooling assumed a file of that name | Normalization lives in backend/src/services/webhookNormalizer.ts (singleton export `webhookNormalizerService` at line 1337); no `webhookNormalizerService.ts` file exists |
| 2 | `AI_REPLY_DELAY_MS` absent from backend/.env.example and CLAUDE.md §10 | Read in code with default 8000 ms (backend/src/jobs/processInboundMessage.ts:178, 887) |
| 3 | `WEBHOOK_WORKER_CONCURRENCY` and sibling `*_WORKER_CONCURRENCY` vars absent from backend/.env.example and CLAUDE.md §10 | Read in code (backend/src/jobs/workers.ts:71-75); appear only in docker-compose.prod.yml:66-70 |
| 4 | CLAUDE.md §6 lists analytics_events types as message_received / ai_reply_sent / human_reply_sent / order_created / order_confirmed / feedback_submitted | Ingestion also logs `message_edited` (processInboundMessage.ts:157) and `ai_reply_echo` (processInboundMessage.ts:730, 793) |
| 5 | CLAUDE.md §10: `QUALITY_THRESHOLD` default 0.1 (matches code, aiQualityService.ts:28) | backend/.env.example:23 ships `QUALITY_THRESHOLD=0.6` — 6× the documented default for envs built from the example |
| 6 | CLAUDE.md §10: `OPENAI_EMBEDDING_MODEL` default `text-embedding-3-large` (matches code fallback, openaiClient.ts:35-36) | backend/.env.example:26 ships `text-embedding-3-small`; the code/doc default emits 3072-dim vectors incompatible with the `vector(1536)` schema (migrations 029:4, 047:12; no `dimensions` param, embeddingService.ts:12-15) — only the example value is schema-consistent |
| 7 | CLAUDE.md §11: Bull Board at `/api/admin/queues` | Mounted at `/admin/queues` with no `/api` prefix (backend/src/jobs/bullBoard.ts:14, backend/src/app.ts:154); every other route is /api-prefixed and no proxy rewrite exists in the repo |
| 8 | CLAUDE.md §5 queue table: `notifications` = "Outbound alert notifications" | Processor is an explicit no-op placeholder (backend/src/jobs/processNotificationJob.ts:4-12) and no code enqueues to notificationsQueue; exhaustion alerts go inline via axios in failureHandler.ts:34-49 |
| 9 | CLAUDE.md §5 cron inventory lists 5 crons; describes the `default` queue as "product embeddings, image fingerprints" | Code registers 7 schedulers — `embeddingReconcileFast` every minute and `imageFingerprintReconcileFast` every 2 minutes are omitted (reconcileProductEmbeddings.ts:45-46; reconcileProductImageFingerprints.ts:22-23); `refreshMetaTokens` and `monthlyUseCaseSnapshot` also run on the default queue (workers.ts:140-147) |
| 10 | In-code comment: monthlyUseCaseSnapshot.ts:43 "Upsert a commission_reports row" | `createCommissionReport` is a plain INSERT with no conflict clause (commissionReport.ts:49-68); with inherited `attempts: 3` and `billing_status` remaining 'unbilled' after stamping, a mid-job retry can insert duplicate period reports |
| 11 | In-code comments: processAIReply.ts:3459-3460 and conversationController.ts:217 claim the delay-0 close enqueue with shared jobId "cancels" the delayed 4 h evaluation | BullMQ ignores an add whose jobId already exists uncompleted — the immediate evaluation is dropped and the delayed job persists |
| 12 | In-code comment: processAIReply.ts:1169 — the fairness re-add "inherit[s] the original jobId/dedup behaviour if present" | No jobId or original opts are passed to the re-add (processAIReply.ts:1164-1171); the fresh add also resets the attempts counter |
| 13 | Env documentation gaps beyond #2-3 | `AI_MAX_REPLIES_PER_HOUR`, `AI_CONVERSATION_LOCK_TTL_MS`, `INTENT_THRESHOLD`, `COMMISSION_SESSION_GAP_HOURS`, `HUMAN_HOLD_MINUTES`, `AI_HISTORY_FETCH_LIMIT`, `AI_REPLY_TEMPERATURE`, `CONTEXT_MAX_HISTORY_TOKENS`, `UNCERTAIN_ANSWER_FALLBACK_ENABLED`, `OPENAI_MAX_RETRIES`, `OPENAI_TIMEOUT_MS`, `HNSW_EF_SEARCH_MAX` are read by code but absent from backend/.env.example (several documented in CLAUDE.md §10 only); `AI_MAX_CONCURRENT_PER_TENANT` only commented at .env.example:78 |
| 14 | CLAUDE.md §7: "openaiClient.ts — OpenAI SDK client singleton; all AI calls go through this" | AIProductProcessingService.ts:34 constructs its own `new OpenAI({ apiKey })`, bypassing the singleton's retry/timeout config, with fallback model `'gpt-4o-mini'` (line 35) vs the singleton's `'gpt-4o'` for the same `OPENAI_CHAT_MODEL` env var |
| 15 | CLAUDE.md §7 pipeline step 6: "Product name hallucination filter → strip invented SKUs" | `filterHallucinatedProductNames` does not strip: on detection the ENTIRE reply is replaced with a holding message, AI is paused, and an alert is created (processAIReply.ts:2858-2875; `finalReplyText = HOLDING_MESSAGES[replyLocale].productKnowledgeEscalation` at 2872) |
| 16 | CLAUDE.md §7 pipeline step 6: "Price hallucination filter → strip wrong prices" | Same pattern — the whole reply is replaced with the holding message, never price-stripped (processAIReply.ts:2808-2812) |
| 17 | CLAUDE.md §7 table: intentDetectionService detects `hasCustomerPhone` | The service returns no phone field (`IntentResult`, intentDetectionService.ts:4-12); phone is resolved separately from contact metadata / message regex scan / WhatsApp external id (processAIReply.ts:3536-3545) |
| 18 | CLAUDE.md §7 guard ordering ("…price filter → name filter → quality evaluation … → order confirmation formatting") | Actual order: usage guards → info gap → health guard → order-confirmation formatting (2575) → data-confirmation overrides → quality eval (2721) → price guard (2789) → name guard (2857) → uncertain-answer guard (2900); quality eval runs before the hallucination guards, which then clear its flags (processAIReply.ts:2815-2816) |
| 19 | CLAUDE.md §11: "if a reply is blocked, no `ai_reply_sent` event fires and the use-case eval job may not be enqueued" | Guards replace text but still send; `ai_reply_sent` is logged and the eval job enqueued even when the channel send failed (processAIReply.ts:3448, 3461 precede the failure branch at 3472). Only `[NO_REPLY]`/precheck exits skip the enqueue |
| 20 | CLAUDE.md §10 / .env.example: `PORT` default 8000 | Code fallback is 3000 (backend/src/server.ts:15) |
| 21 | CLAUDE.md §6: "68 numbered SQL migration files" | 69 `.sql` files — two share prefix `062` (062_compact_edge_case_guidelines.sql, 062_message_product_context.sql) |
| 22 | CLAUDE.md §5: "Controllers pass tenantId … into every query" | Multiple model functions query without tenant predicates (e.g. `findMessagesByConversation`, message.ts:304-321 — the main AI history fetch; `findChannelByTypeAndExternalId`, channel.ts:119-128; global `external_message_id` dedupe, message.ts:290-298) |
| 23 | .env.example:15: `OPENAI_CHAT_MODEL=gpt-4o-mini` | Code fallback is `'gpt-4o'` (openaiClient.ts:31) — three different effective chat models depending on config source |
| 24 | In-code comment: processAIReply.ts:1083-1084 reasons about "AI_WORKER_CONCURRENCY=2" | Code default is 5 (workers.ts:72); prod overlay is 2 (docker-compose.prod.yml:67) |
| 25 | In-code comment: server.ts:51-53 claims deploy health-check overlap of old/new containers | Single-host Compose `up -d` recreates in place (stop old → start new); no overlap window exists in this topology |
| 26 | DEPLOYMENT.md:232-234: `/api/auth/refresh` "exempt entirely" from rate limiting | A dedicated refreshLimiter applies (backend/src/app.ts:101-119; in-code comment at app.ts:86-87 is current) |
| 27 | CLAUDE.md §7 pre-reply paths list three (cancellation/refund, post-purchase, order-info updates incl. "quantity") | Code has five paths — wrong-product (processAIReply.ts:1503-1591) and delivery-ETA auto-reply (1642-1716) are undocumented; the order-info path updates address/name/phone/notes only, not quantity (1821-1832) |
| 28 | aiService.ts:614 comment: query-embedding cache is "LRU-style" | Reads never refresh insertion order; eviction is FIFO (aiService.ts:633-644) |
| 29 | CLAUDE.md §5 route table lists `/ai-config` among tenant AI routes | Tenant-facing PUT `/api/ai-config` and POST `/api/ai-config/test` return hard 403s (aiConfigController.ts:21-35); only GET works for tenants |
