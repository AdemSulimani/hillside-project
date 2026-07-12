# Phase 2 — Complete Execution Trace (Step Ledger)

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts). Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md for verbatim query evidence.

All paths are relative to repo root; line numbers verified against branch `main`, commit `a8ceb15`. This ledger reconstructs the full lifecycle of one inbound customer message: webhook receipt → AI reply → persistence → draft order. Steps are strictly ordered as executed. Escalating post-reply guards (S-45…S-58) are **not exits** — they replace the reply text and the pipeline continues to send. No recommendations are made in this document.

---

## Step Ledger

### S-01 — Webhook HTTP receipt & raw-body capture
- **Where:** `backend/src/routes/webhooks.ts:8-15` (routes), `backend/src/app.ts:122-128` (rawBody capture), `app.ts:142` (mount), `app.ts:84-93` (rate-limit exemption)
- **Inputs / Outputs:** HTTP POST from Meta (`/api/webhooks/:channelType`, types facebook/instagram/whatsapp — `webhookController.ts:8`) or Viber (`/api/webhooks/viber/:channelId`, per-channel DB UUID URL); output = parsed JSON body + `req.rawBody` Buffer copy
- **External calls / SQL / cache ops:** none. No JWT; no per-IP throttling (`/api/webhooks` explicitly skipped by the general rate limiter, `app.ts:84-93`); no explicit `express.json` size limit
- **Deterministic:** yes
- **Failure behavior:** fail-closed — unknown `:channelType` → 400 `'Unsupported channel type'` (`webhookController.ts:224-227`); missing rawBody → 400 (`webhookController.ts:265-269`, `viberWebhookController.ts:77-81`). Viber non-message events (`webhook` handshake, `delivered|seen|failed|subscribed|unsubscribed|conversation_started`) are ACKed 200 **before any signature check** and never enqueued (`viberWebhookController.ts:92-118`).

### S-02 — Signature verification
- **Where:** Meta: `backend/src/controllers/webhookController.ts:256-282`; Viber: `backend/src/controllers/viberWebhookController.ts:121-165`
- **Inputs / Outputs:** rawBody + `X-Hub-Signature-256` (Meta, HMAC-SHA256 over rawBody with `META_APP_SECRET`/`INSTAGRAM_APP_SECRET`, `webhookController.ts:21-31, 271-274`) or `X-Viber-Content-Signature` (per-bot HMAC keyed by the channel's decrypted access token, `viberWebhookController.ts:147-157`); output = pass/reject
- **External calls / SQL / cache ops:** Viber only: `SELECT * FROM channels WHERE id = $1 AND type = 'viber' LIMIT 1` (no tenant scope, `viberWebhookController.ts:48-54`) + AES decrypt of the stored token. Meta: on first valid event, best-effort `updateChannel(webhook_verified: true)` (`webhookController.ts:284-300`, failure logged, non-blocking)
- **Deterministic:** yes (timing-safe compare, `webhookController.ts:10-15`)
- **Failure behavior:** fail-closed — missing/mismatched signature → 403; missing app secret → 500 (`webhookController.ts:251-254`); Viber channel not found → 404, token decrypt failure → 500

### S-03 — Timestamp skew check
- **Where:** `webhookController.ts:38, 302-307`; `viberWebhookController.ts:10, 168-172`
- **Inputs / Outputs:** body-embedded timestamp (Meta: first `entry[].messaging[].timestamp` or WhatsApp message timestamp, sec/ms auto-detected `webhookController.ts:48-90`; Viber: top-level `payload.timestamp`); rejects if `|now − ts| > 300_000 ms`
- **External calls / SQL / cache ops:** none
- **Deterministic:** conditional — timestamp is read from the (signed) body, but when absent `eventEpochMs` falls back to `Date.now()`, making the check always pass: `const eventEpochMs = payloadTsMs ?? Date.now();` (`webhookController.ts:302-303`)
- **Failure behavior:** fail-closed on stale timestamps (403 JSON `{ error: 'Webhook timestamp out of acceptable range' }`); fail-open when no timestamp exists in the payload

### S-04 — Edge idempotency dedupe (Redis)
- **Where:** `webhookController.ts:145-182, 309-315`; `viberWebhookController.ts:41-45, 175-180`
- **Inputs / Outputs:** dedupe key = concatenation of **all** message `mid`/`id` values in the payload (Meta; reactions get `reaction:<mid>:<ts>` composites; fallback `sha256(rawBody)`), or `viber:<message_token>`; output = proceed / silent-ACK
- **External calls / SQL / cache ops:** Redis `SET webhook_seen:{messageId} '1' EX 86400 NX`
- **Deterministic:** yes
- **Failure behavior:** duplicate → silent-drop with 200 ACK (no enqueue). Note asymmetry: dedupe key covers all message ids while normalization (S-06) reads only the first — a batched multi-message delivery is deduped as a whole but processed first-message-only.

### S-05 — ACK 200 + enqueue webhook job (traceId mint)
- **Where:** Meta: `webhookController.ts:234-248, 335-336` (`res.sendStatus(200); void enqueueInboundPayload();`); Viber: `viberWebhookController.ts:183-208`
- **Inputs / Outputs:** validated payload → BullMQ job `message.inbound` on queue `webhook` with `{ channelType, payload, traceId }`; `traceId = crypto.randomUUID()` minted here (`webhookController.ts:238`, `viberWebhookController.ts:185`)
- **External calls / SQL / cache ops:** `webhookQueue.add` (attempts 3, fixed 5 s backoff, `jobs/queues/webhookQueue.ts:10-14`)
- **Deterministic:** yes
- **Failure behavior:** silent-drop — 200 is sent **before** the enqueue; an enqueue failure is only logged (`console.error('[webhook] failed to enqueue inbound payload', …)`, `webhookController.ts:245-247`), so the platform believes delivery succeeded and never retries. The message is lost.

### S-06 — Webhook job: normalization
- **Where:** `backend/src/jobs/processInboundMessage.ts:434-455`; `backend/src/services/webhookNormalizer.ts:1127-1144` (entry `normalizeEvent`)
- **Inputs / Outputs:** raw channel payload → `InboundMessageDTO` (`webhookNormalizer.ts:4-35`: externalMessageId, contactExternalId, messageType, content, attachmentUrls, isEcho, skipAiReply, …) or `InboundEditDTO`. Only `entry[0]`/`messaging[0]`/`changes[0]`/`messages[0]` are read (first-element-only, e.g. `webhookNormalizer.ts:812-816, 899-903, 1159-1162`). Reactions/stickers set `skipAiReply: true`
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes
- **Failure behavior:** split — for whatsapp/instagram/facebook, `'required message identifiers are missing'` errors are swallowed as non-message events (`shouldIgnoreNormalizationError`, `processInboundMessage.ts:200-206, 449`) = silent-drop; for Viber the same error propagates → throw→retry ×3 → permanent fail + prod `ALERT_WEBHOOK_URL` alert.

### S-07 — Worker-level global DB dedupe
- **Where:** `processInboundMessage.ts:465-472`; SQL in `backend/src/db/models/message.ts:290-298`
- **Inputs / Outputs:** `external_message_id` → skip if already persisted
- **External calls / SQL / cache ops:** `SELECT id FROM messages WHERE external_message_id = $1 LIMIT 1` — global, **no tenant scoping**
- **Deterministic:** yes
- **Failure behavior:** duplicate → silent-drop (log `'[inbound] Duplicate external_message_id, skipping processing'`). This is the idempotency anchor that makes webhook-job retries safe after the message row exists.

### S-08 — Channel / tenant resolution
- **Where:** `processInboundMessage.ts:474-488`; `backend/src/db/models/channel.ts:119-128`
- **Inputs / Outputs:** `(channelType, channelExternalId)` → channel row; `tenant_id` is read **from** the channel row (webhooks carry no tenant identity)
- **External calls / SQL / cache ops:** `findChannelByTypeAndExternalId` — lookup by `(type, external_id)`, no tenant filter, `LIMIT 1`
- **Deterministic:** yes
- **Failure behavior:** throw→retry — `throw new Error('Channel not found for type=… external_id=…')` (`processInboundMessage.ts:478-488`) → 3 attempts, fixed 5 s → permanent fail → prod alert POST (`jobs/failureHandler.ts:34-49`).

### S-09 — Contact profile + contact/conversation upserts
- **Where:** `processInboundMessage.ts:490-598`
- **Inputs / Outputs:** DTO contact fields (+ optional Graph profile fetch) → `contacts` row upsert (`:584`) and `conversations` upsert with `status: 'open'` (`:593`)
- **External calls / SQL / cache ops:** Graph API profile lookups for instagram/facebook (`graph.facebook.com/v25.0`, `graph.instagram.com/v25.0`, throttled 24 h refresh / 10 min attempt, `:46-52, 271-426`); `upsertContact`, `upsertConversation` (idempotent by unique constraints `(tenant_id, channel_id, external_id)` / `(tenant_id, contact_id, channel_id)`)
- **Deterministic:** conditional (Graph fetch outcome varies; upserts deterministic)
- **Failure behavior:** profile fetch failures degrade to fallback names (fail-open); upsert failure → throw→retry.

### S-10 — Attachment re-hosting
- **Where:** `processInboundMessage.ts:600-700`
- **Inputs / Outputs:** attachment URLs / Graph media ids → permanent Cloudinary (images) or Backblaze (audio/docs) URLs; all-failed ⇒ `permanentAttachmentUrls = []` so expiring CDN URLs are never stored (`:693-699`)
- **External calls / SQL / cache ops:** Graph media resolution with bearer token (`:78-86, 619-621`), axios arraybuffer download, Cloudinary/Backblaze upload
- **Deterministic:** no (network)
- **Failure behavior:** per-attachment fail-open — download/upload failures are logged (`'[inbound] Failed to download attachment'`, `:689`) and the attachment dropped; the message is still stored. Uploads are not attempt-scoped: a webhook-job retry re-uploads new objects.

### S-11 — Echo classification (facebook/instagram only)
- **Where:** `processInboundMessage.ts:702-833`; `services/outboundEchoRegistry.ts:47-57`; `webhookNormalizer.ts:82-94`
- **Inputs / Outputs:** echo DTO → one of: self-sent registry hit (text echoes skipped, image echoes stored once as outbound `sent_by:'ai'`); API-origin echo (`app_id` present) → content-dedupe 5 min window else stored as `sent_by:'ai'`, no human hold; human-agent echo (no `app_id`) → `markConversationHumanReplied` + stored `sent_by:'human'` + `setHumanOverrideHold` (default 10 min, `conversationService.ts:343-353`) + analytics `human_reply_sent`
- **External calls / SQL / cache ops:** Redis GET `self_send_echo:{id}` (TTL 600 s, errors swallowed); `findRecentOutboundMessageByContent` (5 min window, `message.ts:561-581`); message INSERT; conversation UPDATE
- **Deterministic:** conditional — classification depends on `isHumanAgentEcho(echoAppId) = echoAppId == null || echoAppId.trim() === ''` (`webhookNormalizer.ts:92-94`) and on Redis registry availability
- **Failure behavior:** Redis hiccup → fail-open to DB content-based dedupe (comment `outboundEchoRegistry.ts:42`). No echo handling exists for whatsapp/viber.

### S-12 — Inbound message persistence + side effects
- **Where:** `processInboundMessage.ts:835-884`
- **Inputs / Outputs:** DTO → `messages` row (`direction:'inbound'`, `sent_by:'customer'`, reply-to snapshot `:846-872`); `touchConversationLastMessageAt` (`:874`); analytics `message_received` (`:876`, fire-and-forget); sockets `new_message` + `conversation_updated` (`:883-884`)
- **External calls / SQL / cache ops:** INSERT into messages; UPDATE conversations; INSERT analytics_events (void); Socket.IO emit via Redis adapter
- **Deterministic:** yes
- **Failure behavior:** message INSERT failure → throw→retry (protected by S-07 dedupe on retry); analytics/sockets are fire-and-forget (silent-drop on failure).

### S-13 — Debounced delayed `ai.reply` enqueue
- **Where:** `processInboundMessage.ts:886-907`
- **Inputs / Outputs:** persisted inbound → job `ai.reply` `{ tenantId, channelId, conversationId, messageExternalId, traceId }` with `delay: AI_REPLY_DELAY_MS` (default 8000 ms); skipped entirely when `skipAiReply === true`
- **External calls / SQL / cache ops:** `aiQueue.getJobs(['delayed','waiting'])` — scans **all** pending ai-queue jobs across all tenants — then `.find()` and removes at most one matching pending `ai.reply` for this conversation before adding the new one (debounce); `aiQueue.add` (attempts 3, exponential from 10 s, `aiQueue.ts:12-13`)
- **Deterministic:** yes (given queue state)
- **Failure behavior:** throw→retry (whole webhook job re-runs; S-07 prevents double message persist; a second enqueue for the same latest inbound is later neutralized by the stale-job guard S-21). The edit path re-enqueue (`:178-198`) omits `traceId`.

### S-14 — `ai.reply` start: per-tenant fairness slot
- **Where:** `backend/src/jobs/processAIReply.ts:1152-1190` (limit `:1093-1096`, backoff `:1098`)
- **Inputs / Outputs:** job data → admitted or re-queued; slot counter incremented
- **External calls / SQL / cache ops:** Redis `INCR ai_active_jobs:{tenantId}` (+ `EXPIRE 300` on first increment); over `AI_MAX_CONCURRENT_PER_TENANT` (default 8) → `DECR` + `aiQueue.add('ai.reply', data, { delay: 3000 })` — a **fresh** job with reset attempts counter (no jobId inherited despite the comment at `:1169`)
- **Deterministic:** conditional (depends on concurrent load)
- **Failure behavior:** over-limit → deferred (re-enqueue +3 s), original job completes successfully [exit E1]. Slot release guarded by flag and executed in `finally` (`:1185-1190, 3845`).

### S-15 — Per-conversation serialization lock
- **Where:** `processAIReply.ts:1197-1222` (TTL `:1136-1139`; Lua release `:1141-1146`)
- **Inputs / Outputs:** conversationId → lock held or job re-queued
- **External calls / SQL / cache ops:** Redis `SET ai_conv_lock:{conversationId} <uuid> PX 300000 NX`; token-checked Lua compare-and-delete on release
- **Deterministic:** conditional (contention)
- **Failure behavior:** not acquired → release tenant slot, re-enqueue +3 s, return [E2]. Lock always released in `finally` (`:3839-3846`).

### S-16 — Per-conversation reply rate limit
- **Where:** `processAIReply.ts:1226-1294` (Lua script `:1110-1118`)
- **Inputs / Outputs:** conversationId → count vs `AI_MAX_REPLIES_PER_HOUR` (default 25, re-read per job `:1227-1229`); breach ⇒ permanent pause
- **External calls / SQL / cache ops:** Redis Lua atomic `INCR ai_rate_limit:{conversationId}` + `EXPIRE 3600`; on breach one DB transaction: `setConversationAiPaused(true)` + `createAIAlert(reason:'rate_limit_exceeded')` (`:1250-1264`); sockets `ai_alert` + `conversation_updated`
- **Deterministic:** yes (counter arithmetic)
- **Failure behavior:** breach → canned-silence exit [E3]: AI paused persistently (manual unpause required), alert raised, customer gets nothing. The counter increments **per job attempt, before the gates** — retries and later-skipped jobs consume budget (`:1231-1236`); fairness/lock re-delays do not (they exit before INCR).

### S-17 — Enablement gate L1: tenant global toggle
- **Where:** `processAIReply.ts:1296-1301`
- **Inputs / Outputs:** `ai_configs.is_active` → continue or exit
- **External calls / SQL / cache ops:** `findAIConfigByTenant(tenantId)` — direct DB read (not the 900 s Redis `ai_config:` cache; cf. `caching-config` §A.5)
- **Deterministic:** yes
- **Failure behavior:** `!aiConfig?.is_active` → silent-drop [E4] (log only; customer gets nothing).

### S-18 — Enablement gate L2: channel
- **Where:** `processAIReply.ts:1303-1313`
- **Inputs / Outputs:** channel row → continue or exit
- **External calls / SQL / cache ops:** channel SELECT
- **Deterministic:** yes
- **Failure behavior:** channel missing → silent-drop [E5]; `!channel.ai_enabled` → silent-drop [E6].

### S-19 — Enablement gate L3: conversation (pause / human hold)
- **Where:** `processAIReply.ts:1315-1336`; reschedule helper `:430-476`
- **Inputs / Outputs:** conversation row → continue, exit, or re-scheduled job
- **External calls / SQL / cache ops:** conversation SELECT; on active hold, `aiQueue.add` with `delay = remainingMs + 5000` (`:417`)
- **Deterministic:** yes (clock-based)
- **Failure behavior:** conversation missing → silent-drop [E7]; `ai_paused` → silent-drop [E8]; `human_override_until` in the future → deferred [E9] via `rescheduleReplyAfterHumanHold`, but only if the hold is within `getHumanHoldMinutes()*60_000 + 60_000` (anomalous holds → skip), the job is still for the latest inbound, and no human answered it (`:438-467`).

### S-20 — History load + burst merge
- **Where:** `processAIReply.ts:1338` (load), `:300-341` (burst)
- **Inputs / Outputs:** conversationId → last `HISTORY_FETCH_LIMIT` (default 40) messages; consecutive inbound messages since last outbound merged: last 5 kept (`.slice(-5)`, `:316`), near-duplicates dropped (containment or token Jaccard ≥ 0.82, `:297`), texts joined with `\n`, attachment URLs merged → `mergedInboundText` becomes the retrieval/classifier query
- **External calls / SQL / cache ops:** `findMessagesByConversation` — `WHERE conversation_id = $1` only, **no filter** on flagged/quality/send_status (`message.ts:304-321`)
- **Deterministic:** yes
- **Failure behavior:** throw→retry (SQL error fails the job).

### S-21 — Staleness / content guards
- **Where:** `processAIReply.ts:1341-1367`
- **Inputs / Outputs:** burst context → proceed or silent exit
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes
- **Failure behavior:** all silent-drop — no inbound found [E10]; **stale-job guard**: `lastInbound.external_message_id !== data.messageExternalId` [E11] (a newer inbound's own job supersedes); reaction-only prefix [E12]; emoji-only with no attachments (`isEmojiOnlyText`, `:1069-1077`) [E13]; empty text + no attachments [E14].

### S-22 — Reply-language detection (LLM #1)
- **Where:** `processAIReply.ts:1373`; impl `aiService.ts:1814-1868`
- **Inputs / Outputs:** inbound text + recent turns → locale `sq`/`en`, threaded through every canned message and holding text
- **External calls / SQL / cache ops:** OpenAI `chat.completions.create` (`OPENAI_CHAT_MODEL`, temp 0, json_object, max_tokens 32) — skipped when `heuristicallyDetectLanguage` is unambiguous (`aiService.ts:1831-1834`)
- **Deterministic:** no (LLM; heuristic fast-path is deterministic)
- **Failure behavior:** fail-open — catch → heuristic over recent customer turns → `DEFAULT_REPLY_LOCALE = 'sq'` (`aiService.ts:90`).

### S-23 — Pre-reply path: cancellation / refund (LLM #2)
- **Where:** `processAIReply.ts:1380-1501`; classifier `aiService.ts:2439-2521`
- **Inputs / Outputs:** inbound text → if `(is_cancellation || is_refund) && confidence > 0.8` (`:1389`): canned ack sent, latest open order flagged cancellation/refund-requested, alerts `cancellation_request`/`refund_request`, `ai_paused = true` (`:1471`), job ends
- **External calls / SQL / cache ops:** OpenAI classifier (temp 0, json, 200 tok); order SELECT/UPDATE; alert INSERT; channel send API; message INSERT; sockets `ai_alert`, `order_action_required`, `new_message`, `conversation_updated`. Send gated by `shouldStillSendAutomatedReply` (`:351-414` — re-validates all gates + staleness + human-takeover)
- **Deterministic:** no (LLM). Confidence-boost pattern: `if ((is_cancellation || is_refund) && confidence === 0) confidence = 0.9;` (`aiService.ts:2509-2511`) — a model asserting intent with zero confidence still clears the 0.8 gate
- **Failure behavior:** classifier transport error → thrown → caught by the Phase-C umbrella catch (`:1942-1948`, logs `'escalation detection path failed, continuing normal flow'`) = fail-open to normal reply. Precheck fail → silent-drop [E15]. Path taken → canned-reply exit [E16]. The canned ack send has **no idempotency marker** — a later throw in this path re-sends the ack on retry.

### S-24 — Pre-reply path: wrong product (LLM #3)
- **Where:** `processAIReply.ts:1503-1591`; classifier `aiService.ts:2524-2594`
- **Inputs / Outputs:** trigger `is_wrong_product && confidence > 0.8` (`:1507`) → transaction (`ai_paused=true`, `human_replied=false`, alert `post_purchase_support_request`), canned `postPurchaseSupport` holding message sent
- **External calls / SQL / cache ops:** OpenAI classifier; DB transaction; channel send; message INSERT; sockets
- **Deterministic:** no (LLM; zero-confidence boost to 0.9 at `aiService.ts:2584-2586`)
- **Failure behavior:** fail-open via umbrella catch; precheck fail → silent-drop [E17]; path taken → canned-reply exit [E18].

### S-25 — Pre-classification: new-order signal + order affirmation (LLM #4, #5)
- **Where:** `processAIReply.ts:1593-1598`; impls `aiService.ts:1046-1080` (`classifyNewOrderSignal`), `aiService.ts:2711-2772` (`detectOrderAffirmationIntent`, affirmation requires confidence > 0.7 `:1596`)
- **Inputs / Outputs:** inbound text → booleans `isLikelyNewOrderSignal` / `isLikelyOrderAffirmation` that veto the post-purchase paths (S-26, S-28) and the order-info-update path (S-29)
- **External calls / SQL / cache ops:** 2 OpenAI classifier calls (temp 0, json, 64/180 tok)
- **Deterministic:** no (LLM)
- **Failure behavior:** new-order: `catch {}` → keyword fallback (`aiService.ts:1075-1079`); affirmation: parse-fail → `{is_order_affirmation:false, confidence:0}`; transport → umbrella catch (fail-open). Affirmation has **no** zero-confidence boost (`aiService.ts:2759-2763`).

### S-26 — Pre-reply path: post-purchase support intent detection (LLM #6, conditional)
- **Where:** `processAIReply.ts:1597-1637`; regex cue `:1020-1030`; classifier `aiService.ts:2597-2709`
- **Inputs / Outputs:** runs only when `hasPostPurchaseIssueCue(inboundText)` (regex) fires AND neither affirmation nor new-order signal is present; produces intent flags incl. ETA-only flag; threshold confidence > 0.8 (`:1634`)
- **External calls / SQL / cache ops:** 1 OpenAI classifier (temp 0, json, 240 tok)
- **Deterministic:** conditional (regex gate deterministic; classifier LLM; zero-confidence boost to 0.9, `aiService.ts:2686-2688`)
- **Failure behavior:** fail-open (parse → all-false; transport → umbrella catch).

### S-27 — Pre-reply path: delivery-ETA-only auto-reply
- **Where:** `processAIReply.ts:1642-1716`; canned reply `:620-625`; deterministic cue regex `:1032-1046`
- **Inputs / Outputs:** trigger = LLM says pure ETA query (conf > 0.8) OR the regex `hasDeliveryEtaOnlyCue` alone; if `tenants.delivery_time` configured → fixed reply `'Porosia juaj do të mbërrijë brenda ${hours} orëve.'` / `'Your order will arrive within ${hours} hours.'`; **no alert, no pause**, conversation continues. No configured delivery time → falls through to normal flow
- **External calls / SQL / cache ops:** channel send; message INSERT; `touchConversationLastMessageAt`; sockets
- **Deterministic:** conditional (regex path deterministic; LLM path not)
- **Failure behavior:** precheck fail → silent-drop [E19]; path taken → canned-reply exit [E20]; tx/send errors → umbrella catch fail-open.

### S-28 — Pre-reply path: post-purchase support escalation
- **Where:** `processAIReply.ts:1718-1808`
- **Inputs / Outputs:** any of the four post-purchase flags && conf > 0.8 → transaction (pause + `human_replied=false` + alert `post_purchase_support_request`), canned `postPurchaseSupport` holding message
- **External calls / SQL / cache ops:** DB transaction; alert INSERT; channel send; message INSERT; sockets
- **Deterministic:** no (depends on S-26 LLM output)
- **Failure behavior:** precheck fail → silent-drop [E21]; path taken → canned-reply exit [E22]; errors → umbrella catch fail-open.

### S-29 — Pre-reply path: order-info update (LLM #7)
- **Where:** `processAIReply.ts:1809-1941`; classifier `aiService.ts:2790-2921`
- **Inputs / Outputs:** guarded by `!isLikelyNewOrderSignal && !isLikelyOrderAffirmation` (`:1813`); trigger `is_order_info_update && confidence > 0.82` (`:1818`); extractable fields: `delivery_address`, `customer_name`, `customer_phone`, `notes` (**not quantity**, `:1821-1832`); latest active order in this conversation only → UPDATE order, canned `orderInfoUpdated` confirmation, alert `order_info_updated` with before/after, `order_updated` socket. **AI not paused.** No active order → fall through
- **External calls / SQL / cache ops:** OpenAI classifier (temp 0, json, 350 tok; zero-confidence boost to 0.85, `aiService.ts:2888`); order SELECT/UPDATE; alert INSERT; channel send; message INSERT
- **Deterministic:** no (LLM)
- **Failure behavior:** classifier internal catch → default no-intent (fail-open, `aiService.ts:2916-2921`). **Ordering hazard:** the order row is updated (`:1851-1855`) **before** the send precheck — precheck fail → silent-drop [E23] with the order already mutated and no confirmation sent. Path taken → canned-reply exit [E24].

### S-30 — Parallel image-request classification launch (LLM #8)
- **Where:** `processAIReply.ts:1951-1955`; impl `aiService.ts:4198-4295` (regex pre-screen `:4168-4187`)
- **Inputs / Outputs:** inbound text → promise of `{ is_image_request, product_refs }`, consumed later at S-61; launched fire-and-forget in parallel with generateReply
- **External calls / SQL / cache ops:** 1 OpenAI classifier (temp 0, json, 96 tok) unless the regex pre-screen rejects
- **Deterministic:** no (LLM)
- **Failure behavior:** fail-open — `.catch(() => null)` at launch and internal catch → false result.

### S-31 — generateReply: config/prompt/tenant/catalog cache loads + block self-heal
- **Where:** `aiService.ts:3446-3515` (entry `generateReply`); loaders `:201-306`; seed/self-heal `:232-251`
- **Inputs / Outputs:** tenantId → `ai_configs` row (or `DEFAULT_AI_CONFIG`), tenant prompt blocks, tenant row, fallback catalog
- **External calls / SQL / cache ops:** Redis read-aside caches: `ai_config:{t}` EX 900, `tenant_prompt_blocks:{t}` EX 900, `tenant:{t}` EX 1800, `products:{t}` EX 120; on miss → SQL + `SET`. `ensureTenantPromptBlocksSeeded` runs on **every** call: seeds blocks if 0 rows and executes `forceSyncLockedBlocksForTenant` UPDATE (no-op equality-guarded) (`:239-251`)
- **Deterministic:** conditional — cache staleness windows (≤900/1800 s; delete-only invalidation can be resurrected by an in-flight refill — `caching-config` §B.4); missing `ai_configs` row caches `DEFAULT_AI_CONFIG` with `is_active: true` for 900 s (`:219-228`)
- **Failure behavior:** corrupt cached JSON → self-delete + DB fallback (fail-open); SQL failure → throw→retry.

### S-32 — generateReply: parallel routing classifiers (LLM #9–#12)
- **Where:** `aiService.ts:3487-3496` (Promise.all): `customerAskedAboutPrice` (`:1247-1328`), `customerAskedAboutDiscount` (`:1362-1395`), `classifyProductAttributeIntent` (`productAttributeIntentService.ts:102`), `classifyOtherProductOptionsIntent` (`:1677-1759`)
- **Inputs / Outputs:** inbound text → routing booleans: price-context injection, discount handling (can lead to `[NO_REPLY]`), attribute-question routing, wide-category search switch
- **External calls / SQL / cache ops:** up to 4 OpenAI classifiers (temp 0, json, 64-128 tok); attribute-intent and other-options have regex fast-paths/pre-screens
- **Deterministic:** no (LLM; regex fast-paths deterministic)
- **Failure behavior:** all fail-open to keyword/regex fallbacks (`kw` class). Repeated-discount short-circuit: `customerAskedDiscount && assistantAlreadyFinalizedDiscount` → return `[NO_REPLY]` without calling the main model (`aiService.ts:3519-3539`).

### S-33 — Retrieval: query embedding generation
- **Where:** `aiService.ts:650-664` (`generateQueryEmbeddingWithTimeout`), cache `:614-644`; API call `embeddingService.ts:12-15`
- **Inputs / Outputs:** raw trimmed burst text (no lowercasing/diacritic folding/stop-word removal — `retrieval` §3.5) → 1536-dim vector or `null`
- **External calls / SQL / cache ops:** in-process Map cache (max 256 entries, FIFO eviction despite "LRU-style" comment, key = `${model}` + U+0000 + `${text}` (NUL separator, `aiService.ts:629-631`), no TTL); on miss `openai.embeddings.create` (model `OPENAI_EMBEDDING_MODEL`, **no `dimensions` param** — code default `text-embedding-3-large` emits 3072-dim, incompatible with `vector(1536)` schema; only `.env.example`'s `text-embedding-3-small` is schema-consistent — `retrieval` §6) raced against a 5 s timer (`EMBEDDING_QUERY_TIMEOUT_MS`); the race resolves `null` without aborting the HTTP request
- **Deterministic:** no (network; embedding values deterministic per model/input)
- **Failure behavior:** fail-open — timeout/error → `null` → keyword-only retrieval (`:661-663`).

### S-34 — Retrieval: semantic similarity search (pgvector)
- **Where:** `backend/src/db/models/product.ts:759-815`; threshold filter `aiService.ts:703-709`
- **Inputs / Outputs:** query vector → up to `limit` products with `similarity = 1 - (embedding <=> $2)`; JS post-filter `p.similarity >= SIMILARITY_THRESHOLD` (default 0.65; **no** SQL-side floor)
- **External calls / SQL / cache ops:** transaction with `SET LOCAL hnsw.ef_search = N`; `SELECT *, 1 - (embedding <=> $2) AS similarity FROM products WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active AND embedding IS NOT NULL AND (embedding_model IS NULL OR embedding_model=$4) ORDER BY embedding <=> $2 LIMIT $3`. HNSW index is **global across tenants** (tenant filter is a post-filter); adaptive ef_search: first pass `max(100, limit)`, one retry at `max(500, limit)` when fewer than `limit` rows returned (`product.ts:804-814`)
- **Deterministic:** yes given index state (ANN traversal is deterministic per graph)
- **Failure behavior:** throw→(caught upstream in retrieval orchestration) — semantic source degraded; NULL-embedding rows silently excluded (remain keyword-searchable).

### S-35 — Retrieval: lexical sources + RRF fusion + ranking
- **Where:** `aiService.ts:677-762` (`matchProductsForCustomerMessage`); fusion `:431-448`; sources SQL `product.ts:510-715`
- **Inputs / Outputs:** burst text → fused product list capped at caller `limit` (`FOCUSED_PRODUCT_MATCH_LIMIT = 10` focused; `CATEGORY_GROUP_MATCH_LIMIT = 25` group turns). Weighted RRF (`RRF_K = 60`): semantic 2.0, category_tag 1.5, phrase_direct 1.2, keyword 1.0. **Category-intent semantic drop:** when `hasCategoryShoppingIntent` fires and category/tag lexical matches exist, the semantic source is omitted entirely (`:723-736`) — the embedding was still generated and paid
- **External calls / SQL / cache ops:** trigram-indexed ILIKE queries (`searchProductsByCategoryOrTag`, `searchProductsByCatalogPhrases` — sequential per phrase, `searchProducts` disjunctive terms); one structured retrieval log line (`:742-752`)
- **Deterministic:** yes (given DB state and classifier inputs)
- **Failure behavior:** lexical SQL error → throw→retry; no relevance threshold on lexical hits (any ILIKE substring qualifies); duplicate ids within `phraseDirect` accumulate multiple RRF contributions (`retrieval` §2.3).

### S-36 — Retrieval: contextual routing / persisted-ID reuse / fallbacks / self-heal
- **Where:** `aiService.ts:3541-3783`; persisted IDs `message.ts:183-191` + `product.ts:285-308`; anchors `productRetrievalService.ts:209-290`; self-heal `reconcileProductEmbeddings.ts:228-261`
- **Inputs / Outputs:** ordered strategy: other-options fresh search → contextual follow-up resolution (persisted `messages.product_ids` → conversation anchor → assistant-text re-search) → fresh RRF search → second contextual pass → deterministic persisted-ID safety net (+ rare `classifyContextualProductFollowUp` LLM, `:3722`) → zero-hit self-heal (priority-1 embed jobs when tenant has NULL-embedding products); non-meaningful queries with zero hits → alphabetical `FALLBACK_CATALOG_LIMIT = 20` (Redis-cached 120 s); meaningful queries with zero hits → deliberately empty product list (`:3767-3779`)
- **External calls / SQL / cache ops:** SQL rehydration (tenant-scoped, active-only, deleted products silently dropped); Redis `products:{t}`; BullMQ `defaultQueue.add` for self-heal; occasional LLM (16 tok)
- **Deterministic:** conditional — deterministic except the rare LLM follow-up gate
- **Failure behavior:** each layer falls through to the next (fail-open); follow-up classifier error → `false` (fail-closed toward not reusing).

### S-37 — Vision pipeline (customer images; conditional)
- **Where:** `aiService.ts:3786-3800` → `productImageMatchingService.ts:555-801`; policy `productImageMatchPolicy.ts:191-266`
- **Inputs / Outputs:** attached image(s) → vision extraction (brand/name/confidence) → fingerprint-text embedding → ANN over `product_image_fingerprints` (SQL-side floor `>= IMAGE_SIMILARITY_THRESHOLD` 0.62) → optional ambiguity re-rank (2nd vision call when top-2 gap ≤ 0.04) → text tiers → fusion → composite confidence → decision ladder (confident/tentative/clarify/not_in_catalog); sets `productNotInCatalog`, `shouldAskImageClarification`, `imageMatchConfidence`
- **External calls / SQL / cache ops:** 1–2 vision completions per image (`OPENAI_VISION_MODEL`, temp 0, 750/120 tok; Redis cache `cust_vision:{t}:{hash}` 1 h) + 1 embedding per image; pgvector fingerprint SQL (single pass, `ef_search = max(100, limit*3)`); `vision_product_match` analytics event
- **Deterministic:** no (vision LLM)
- **Failure behavior:** ANN failure → fail-open to text matching (`:600-602`); re-rank failure → fail-open to vector order (`:367-371`); extraction empty → `null` handling per policy.

### S-38 — Catalog context assembly
- **Where:** `aiService.ts:2034-2127` (`formatProductCatalog`); extensions `:3838-3866`
- **Inputs / Outputs:** matched products → structured text: per-product Brand/Product/Type lines; `Price: €N.NN` only when `customerAskedPrice || customerAskedDiscount`; discounted-price line or "not configured"; brief (200-char cap) vs full description/usage modes per turn type; agent-only stock-status line; zero-match guardrails (`[This business has N active product(s)… do NOT claim a product does not exist…]`); hidden-count note. Optional: attribute aggregation summary + `Verified packaging details read from product images` block
- **External calls / SQL / cache ops:** `getProductImageDerivedContext` DB read (try/catch warn-only)
- **Deterministic:** yes
- **Failure behavior:** image-derived context failure → fail-open (context omitted, `:3863-3865`).

### S-39 — System prompt construction
- **Where:** base `aiService.ts:2249-2298`; runtime appends `:3919-4092`; blocks `promptAssemblyService.ts:76-96`; restrictions footer `:2306-2328, 4086-4092`
- **Inputs / Outputs:** config + tenant + catalog context + blocks → system prompt. Order: identity/tone/personality/strategy/objections → business profile (desc capped 2000 chars) → product catalog → QA pairs → Guidelines (tenant prompt blocks, sort_order asc, `enabled` filter only — catalog `is_active` **not** checked; vision block dropped on text turns) → conditional appends (shared-content, image-uncertainty, group rules, other-options) → unconditional `SHORTEST_ANSWER_APPEND` + `PRODUCT_DESCRIPTION_CONCISE_APPEND` → conditional price-list/targeted/attribute/packaging appends → closing append (after S-41) → **restrictions footer always last** (operator rules + platform policy). `{{TOKEN}}` placeholders expanded per locale; unknown tokens stay literal. Typical size ≈ 26k–33k chars (~6.5k–8.3k tokens), category turns ~40k+ chars (`prompt` §f)
- **External calls / SQL / cache ops:** none beyond S-31 caches
- **Deterministic:** yes (given inputs)
- **Failure behavior:** n/a (pure assembly). Two "highest priority" claims coexist (SHORTEST_ANSWER vs restrictions footer); orphan DB-only block `guidelines.offers_promotions` injected despite catalog-inactive (`prompt` observations 1-2).

### S-40 — History windowing, deterministic summary, truncation, message array
- **Where:** split `aiService.ts:3476-3484`; summary `:3049-3090`; truncation `:4003-4038`; array `:3092-3183`
- **Inputs / Outputs:** 40-message window → last 10 raw turns + deterministic string-statistics summary of the older ≤30 (first/last previews 140 chars, last 2 customer highlights 120 chars); truncation: `while (historyTokenTotal > 6000 && historyForPrompt.length > 3)` drop-oldest, tokens = chars/4 (system prompt and inbound **excluded** from the budget; computed estimates unused). Array: system prompt + optional second system message (summary) + history (customer→`user`, everything else→`assistant` — human and AI outbound indistinguishable; **no filter** on flagged/failed rows) + current inbound with `image_url` parts (historical attachments never re-sent as images); reply-to wrapping and post-reply edit hints applied
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes
- **Failure behavior:** n/a (pure). Truncation add/remove measures differ for edited customer messages (`prompt` §c).

### S-41 — Conversation-ending classifier + `[NO_REPLY]` short-circuits (LLM #13)
- **Where:** `aiService.ts:4040-4084`; classifier `:3323-3361`; silence sites `:3519-3539` (discount, pre-model) and `:4066-4077` (repeat closing)
- **Inputs / Outputs:** inbound + last assistant turn → either append closing-sentence instruction, or return `{ reply: '[NO_REPLY]' }` without calling the main model (when the previous assistant message already was a known closing)
- **External calls / SQL / cache ops:** 1 OpenAI classifier (temp 0, json, 64 tok); polite-thanks regex fast-path
- **Deterministic:** no (LLM)
- **Failure behavior:** fail-open — `catch { conversationEnding = false; }` (`:4046-4048`).

### S-42 — Model selection, params, main LLM completion (LLM #14)
- **Where:** `aiService.ts:4106-4132`
- **Inputs / Outputs:** messages array → reply text. Model: `hasImages ? OPENAI_VISION_MODEL : (config.custom_model_id || OPENAI_CHAT_MODEL || 'gpt-4o')` — the tenant fine-tune is bypassed on vision turns. Params: `temperature: replyTemperature` (default `AI_REPLY_TEMPERATURE` 0.3; `min(·,0.3)` on uncertain image matches `:4113-4116`), `max_tokens: 768`; **no** `seed`, `top_p`, `response_format`, penalties, `stop`, or streaming. Post-processing: `normalizeProductMentionsForReply` (`:4132`); `matchedProducts` emptied when the full-catalog fallback context was used (`:4139`)
- **External calls / SQL / cache ops:** `openai.chat.completions.create` via singleton client (maxRetries 3, timeout 60 s, `openaiClient.ts:15-29`)
- **Deterministic:** no (sampling at temp 0.3, no seed)
- **Failure behavior:** empty response → `throw new Error('OpenAI returned an empty response')` (`:4127-4128`) → throw→retry (BullMQ, 3 attempts, exponential from 10 s; each retry re-runs S-14…S-41 and re-consumes rate-limit budget).

### S-43 — `[NO_REPLY]` exit
- **Where:** `processAIReply.ts:1983-1985`
- **Inputs / Outputs:** `replyText.trim() === '[NO_REPLY]'` → job ends
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes (given reply)
- **Failure behavior:** silent-drop [E25] — deliberate silence: no send, no outbound row, no quality eval, no `ai_reply_sent` event, no use-case eval enqueue.

### S-44 — Guard signal: out-of-stock canned-reply detection
- **Where:** `processAIReply.ts:1989`; `aiService.ts:1941-1956`
- **Inputs / Outputs:** reply text → `isOosCannedReply` boolean (exact string match against `OUT_OF_STOCK_PRODUCT_REPLY.sq/.en`); exempts the reply from most later guards
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes
- **Failure behavior:** n/a (pure).

### S-45 — Guard: usage question unanswered, variant A (LLM #15, #16)
- **Where:** `processAIReply.ts:2004-2065`; classifiers `aiService.ts:1003-1044` (`classifyUsageQuestionIntent`), `aiService.ts:2330-2387` (`isUsageQuestionUnanswered`)
- **Inputs / Outputs:** usage-related question + product has `usage_description` + reply not verbatim echo → transaction (`ai_paused=true`, `human_replied=false`, alert `usage_question_unanswered`), `finalReplyText` **replaced** with `usageEscalation` holding message
- **External calls / SQL / cache ops:** 2 OpenAI classifiers (temp 0, json, 64 tok); DB transaction; sockets
- **Deterministic:** no (LLM)
- **Failure behavior:** fail-open — classifier failure → `'usage unanswered classifier failed, sending original reply'` (`:2058-2064`); tx failure → ROLLBACK, original reply kept. (The classifier prompt itself instructs fail-closed — "WHEN IN DOUBT → is_unanswered: true" — but the code paths around it fail open.)

### S-46 — Guard: usage question, no `usage_description` exists (variant B)
- **Where:** `processAIReply.ts:2074-2115`
- **Inputs / Outputs:** `usageQuestionIntent && !attributeQuestion && !usageDescription && !isOosCannedReply` → identical transaction + replacement as S-45 ("must not let the AI answer from its general knowledge")
- **External calls / SQL / cache ops:** DB transaction; no extra LLM
- **Deterministic:** conditional (depends on S-45's LLM intent flag; the gate itself is deterministic)
- **Failure behavior:** tx failure → fail-open (original reply sent).

### S-47 — Guard: usage-escalation holding-message fallback
- **Where:** `processAIReply.ts:2117-2224`; matcher `:543-567`
- **Inputs / Outputs:** the model itself authored escalation-style copy (`isUsageEscalationHoldingMessage`) → alert + pause + `human_replied=false` **without replacing the reply**; may re-run `isUsageQuestionUnanswered` (LLM)
- **External calls / SQL / cache ops:** optional OpenAI classifier; DB transaction
- **Deterministic:** conditional (fuzzy string match deterministic; optional LLM)
- **Failure behavior:** re-check failure → `usageQuestionUnanswered = false` (fail-open, `:2127-2134`).

### S-48 — Guard: product-information gap / partial-answer escalation (LLM #17, #18)
- **Where:** `processAIReply.ts:2226-2487`; `productAttributeAvailabilityService.ts:94` (`detectSpecifiedAttributes`), `productInformationGapService.ts:79` (`assessProductInformationRequest`)
- **Inputs / Outputs:** product-information question (not recommendation/comparison), no prior usage escalation, not OOS → three outcomes complete/partial/none; `shouldEscalate = !assessment.ok || status !== 'complete'` → replace reply with `composePartialAnswer(…)` or missing-info holding message; transaction: pause + `human_replied=false` + alert `product_question_unanswered` with structured details. Skipped when `hadImages` (vision handled it) or `matchedProducts.length === 0`
- **External calls / SQL / cache ops:** `detectSpecifiedAttributes` — only classifier with a real AbortController (6 s) + 5-min in-memory cache; `assessProductInformationRequest` (temp 0, json, 400 tok, `{failClosed:true}`); DB reads for image-derived facts; DB transaction
- **Deterministic:** no (two LLMs + deterministic missing-attribute net)
- **Failure behavior:** mixed — `detectSpecifiedAttributes` **fail-open** (empty set, `:114-116`); `assessProductInformationRequest` **fail-closed** (error ⇒ `ok:false` ⇒ escalate, `productInformationGapService.ts:105-108`) — the only fail-closed classifier in the pipeline; tx failure → fail-open.

### S-49 — Guard: speculative health advice (LLM #19)
- **Where:** `processAIReply.ts:2489-2571`; classifier `aiService.ts:1419-1459`; keyword list `usageSuitabilityHelpers.ts:132+`
- **Inputs / Outputs:** usage question + no prior escalation + reply flagged as speculative health advice (keyword fast-path then LLM) → replace with `usageEscalation` holding + pause + `human_replied=false` + alert `usage_question_unanswered`; catalog-backed advice exempt (`adviceIsFromCatalog`, `:2518-2520`)
- **External calls / SQL / cache ops:** OpenAI classifier (temp 0, json, 64 tok); DB transaction
- **Deterministic:** conditional (keyword path deterministic; LLM path not)
- **Failure behavior:** fail-open — `'[speculative_health_classifier] classifier failed — falling open' … return false;` (`aiService.ts:1450-1458`).

### S-50 — Guard: order-confirmation formatting (LLM #20)
- **Where:** `processAIReply.ts:2575-2591`; classifier `aiService.ts:1118-1166`; helper `orderConfirmationFormatting.ts:189-209`
- **Inputs / Outputs:** `!knowledgeGapEscalated && !isOosCannedReply` → `classifyOrderConfirmationReplyIntent`; on true: strip model-authored ETA clauses, insert canonical delivery line from `tenants.delivery_time`, append fixed follow-up sentence. Edits, never replaces
- **External calls / SQL / cache ops:** 1 OpenAI classifier (temp 0, json, 96 tok)
- **Deterministic:** no (LLM; keyword fallback)
- **Failure behavior:** fail-open to lexical keyword heuristic (`aiService.ts:1151-1166`).

### S-51 — Guard: cross-locale fixed-phrase strip
- **Where:** `processAIReply.ts:2595` (function `:999`, table `:972-993`)
- **Inputs / Outputs:** reply → wrong-locale fixed phrases removed (incl. 5 legacy English variants)
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes
- **Failure behavior:** n/a (pure).

### S-52 — Guard: data-confirmation gate / missing-name override (LLM #21×N)
- **Where:** `processAIReply.ts:2599-2666`; helper `:740-751` (`hasAssistantAskedOrderClosingInConversation`)
- **Inputs / Outputs:** order-flow state → reply may be **replaced** with `DATA_CONFIRMATION_MESSAGES` (`:638-641`) or `MISSING_CUSTOMER_NAME_MESSAGES` (`:648-651`); `isOrderConfirmationReply` reset to false on replacement
- **External calls / SQL / cache ops:** `hasAssistantAskedOrderClosingInConversation` calls `classifyOrderClosingQuestionReplyIntent` (LLM) **per assistant message the regex misses** — unbounded fan-out over the 40-message window; invoked here and again at the draft-order stage (`:3575`)
- **Deterministic:** conditional (deterministic gates over LLM-derived history state)
- **Failure behavior:** per-call fail-open to keyword fallback (`aiService.ts:1239-1244`).

### S-53 — Guard: repeated order-closing-question strip (LLM #22)
- **Where:** `processAIReply.ts:2674-2677` (function `:803-845`, hybrid detector `:796-801`)
- **Inputs / Outputs:** reply → order-closing ask sentences removed. The second parameter `_orderClosingAlreadyAskedInConversation` is **unused** — stripping is unconditional whenever the reply contains an order-closing ask
- **External calls / SQL / cache ops:** regex first, LLM `classifyOrderClosingQuestionReplyIntent` on miss
- **Deterministic:** conditional
- **Failure behavior:** fail-open to keyword fallback.

### S-54 — Guard: generic follow-up-invitation strip (LLM #23)
- **Where:** `processAIReply.ts:2682-2685` (function `:887-928`); classifier `aiService.ts:1484-1534`
- **Inputs / Outputs:** non-order-confirmation reply → invitation sentence ("let me know", "më tregoni", …) stripped; last-resort heuristic drops the final sentence when LLM flagged but regex could not isolate
- **External calls / SQL / cache ops:** LLM-first whole-reply gate (temp 0, json, 64 tok); regex fast-path
- **Deterministic:** conditional
- **Failure behavior:** fail-open (nothing stripped).

### S-55 — Guard: quality evaluation (LLM #24, #25 — eval model)
- **Where:** `processAIReply.ts:2688-2782`; `aiQualityService.ts:98-191`; suppression classifier `aiService.ts:1169-1207`
- **Inputs / Outputs:** `evaluateReply(inbound, finalReply, tenantId, catalogContext)` on `OPENAI_EVAL_MODEL` (temp 0, json, 256 tok) → `quality_score`, off-topic/irrelevant flags; `evaluationTriggersAlert = is_off_topic || is_irrelevant || quality_score < QUALITY_THRESHOLD` (default 0.1; `.env.example` ships 0.6). Skip paths substitute synthetic `quality_score: 0.95`: knowledge-gap escalated, honest negative (`classifyNegativeAvailabilityReply` LLM + exact no-products context), OOS canned, explicit closings. False-flag suppression on order flows via `classifyOrderDetailsCollectionReplyIntent` (LLM, conditional). Flags only — no text mutation; alert+pause deferred to S-66
- **External calls / SQL / cache ops:** 1–3 OpenAI calls
- **Deterministic:** no (LLM)
- **Failure behavior:** fail-open — `evaluateReply` catch → `null` → no flag (`aiQualityService.ts:187-190`).

### S-56 — Guard: price hallucination (deterministic hard gate)
- **Where:** `processAIReply.ts:2789-2837`; module `priceConsistencyGuard.ts` (pure, "performs NO I/O")
- **Inputs / Outputs:** reply prices (€/EUR/ALL/LEK regex, epsilon 0.01) vs `buildCatalogPriceSet(matchedProducts)` (base + discounted) → on any off-catalog price: `finalReplyText` **replaced** with `productKnowledgeEscalation` holding, quality flags cleared (`:2813-2816`); advisory-only cross-turn price-inconsistency log (`:2823-2836`). Gated `!knowledgeGapEscalated && matchedProducts.length > 0 && !isOosCannedReply`
- **External calls / SQL / cache ops:** none (pure regex)
- **Deterministic:** yes
- **Failure behavior:** fail-open when the catalog set is empty — `if (catalogPriceSet.prices.length === 0) return [];` (`priceConsistencyGuard.ts:141`). Alert+pause deferred to S-66 (**no** `human_replied` reset — asymmetric vs S-45…S-49).

### S-57 — Guard: product-name hallucination (LLM #26)
- **Where:** `processAIReply.ts:2847-2883`; validator `aiService.ts:3381-3444`
- **Inputs / Outputs:** reply (truncated to 1200 chars) vs matched product names → hallucination ⇒ **replace** with `productKnowledgeEscalation` holding, clear quality flags. Gated `!knowledgeGapEscalated && !priceHallucinationEscalated && !isOosCannedReply && matchedProducts.length > 0`
- **External calls / SQL / cache ops:** 1 OpenAI classifier (temp 0, json, 128 tok)
- **Deterministic:** no (LLM)
- **Failure behavior:** fail-open **twice** — inside the helper ("never block a reply solely due to guard failure", `aiService.ts:3437-3443`) and in the caller catch (`:2876-2882`). Alert+pause deferred to S-66; no `human_replied` reset.

### S-58 — Guard: uncertain-answer fallback (deterministic)
- **Where:** `processAIReply.ts:2898-2930`; predicate `uncertainAnswerFallbackGuard.ts:229-241`; deflection regexes `:87-131`
- **Inputs / Outputs:** deflection-style reply ("we don't have information", "nuk e di", …) or negative availability without matching products → **replace** with `GET_BACK_TO_YOU_MESSAGES`, clear quality flags. Master switch `UNCERTAIN_ANSWER_FALLBACK_ENABLED` default true. Suppressed when already escalated / OOS / order-flow / honest catalog-integrity negative
- **External calls / SQL / cache ops:** none (pure; consumes S-55's availability classifier output)
- **Deterministic:** yes
- **Failure behavior:** deterministic; env-gated. Alert (`uncertain_answer_escalated`) + pause + `human_replied=false` deferred to S-66.

### S-59 — Guard: contradictory missing-info-notice strip
- **Where:** `processAIReply.ts:2941-2945`; `productInformationGapHelpers.ts:392-430`
- **Inputs / Outputs:** removes/rebuilds a "we will notify you shortly regarding X" notice when the reply already answers X; multi-product gaps left unchanged
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes
- **Failure behavior:** n/a (pure).

### S-60 — Guard: outbound presentation sanitizer
- **Where:** `processAIReply.ts:2951`; `outboundMessageFormatting.ts:63-66`
- **Inputs / Outputs:** strips Markdown bold/italic, list markers, collapses blank lines — "changes formatting only, never the wording"; intended as the last text mutation so sent == persisted (except S-61 runs after it)
- **External calls / SQL / cache ops:** none
- **Deterministic:** yes
- **Failure behavior:** n/a (pure).

### S-61 — Guard: product-image-request override
- **Where:** `processAIReply.ts:2953-3049`
- **Inputs / Outputs:** consumes the parallel S-30 classification; only when **no escalation of any kind** fired (`:2960-2967`); resolves target products (persisted context → image-request resolver → catalog augmentation) and **replaces** the reply with a canned photo confirmation / partial-missing notice / "We'll send you the product photo shortly."
- **External calls / SQL / cache ops:** product resolution SQL
- **Deterministic:** conditional (resolution deterministic; the gating classification is LLM)
- **Failure behavior:** fail-open — resolution failure → original AI reply sent (`:3036-3048`). Runs after the sanitizer, so its canned texts are sent as authored.

### S-62 — Send: idempotency check + precheck
- **Where:** `processAIReply.ts:3057-3092`
- **Inputs / Outputs:** Redis marker `ai_send_done:{conversationId}:{messageExternalId}` (value = prior channel message id or `'1'`) → `alreadySent`; precheck `shouldStillSendAutomatedReply` **bypassed** when `knowledgeGapEscalated || alreadySent` (the guard already set `ai_paused=true`, which would otherwise abort delivery of the holding message, `:3070-3077`)
- **External calls / SQL / cache ops:** Redis GET (`.catch(() => null)` — Redis outage degrades to re-sending); precheck SQL (gates + staleness + human-outbound-after-inbound EXISTS, `:351-414`)
- **Deterministic:** conditional
- **Failure behavior:** precheck fail → silent-drop [E26] (nothing persisted); Redis read failure → fail-open toward duplicate delivery.

### S-63 — Channel send + marker write + echo registration
- **Where:** `processAIReply.ts:3093-3114`; senders `channelSenderService.ts:308-328`; token bucket `outboundChannelRateLimiter.ts:61-98`
- **Inputs / Outputs:** `sendMessage(channel, contact.external_id, finalReplyText)` → `{ success, graphMessageId }`; on success: Redis `SET ai_send_done… EX 3600` + `markSelfSentMessageEcho(graphMessageId)` (echo registry, 600 s)
- **External calls / SQL / cache ops:** per-channel token bucket (Lua, capacity `OUTBOUND_API_MAX_PER_HOUR` 200/h, polls 150 ms up to 60 s then `OutboundChannelRateLimitedError`); Graph API / Viber send (token AES-decrypted per send). WhatsApp text sends return `null` id → marker value `'1'`
- **Deterministic:** no (network)
- **Failure behavior:** **sends never throw into the job** — all errors (incl. rate-limit exhaustion) are caught and returned as `{ success:false, error }` (`channelSenderService.ts:319-327`); handled at S-68. Missing contact → error log, flow continues to persistence.

### S-64 — Product image sends (conditional)
- **Where:** `processAIReply.ts:3116-3181`
- **Inputs / Outputs:** one `sendImageMessage` per resolved product from S-61; own marker `ai_img_sent:{conv}:{msgExtId}` written only when **all** images succeeded (`:3176-3180`)
- **External calls / SQL / cache ops:** channel image-send APIs; Redis SET EX 3600
- **Deterministic:** no (network)
- **Failure behavior:** per-image try/catch; partial failure leaves the marker unset so a retry re-attempts **all** images (all-or-nothing marker); auto-sent images are never persisted as message rows — only the echo registry protects them from human-reply misclassification.

### S-65 — Persist outbound message
- **Where:** `processAIReply.ts:3189-3212`; INSERT `message.ts:323-347`
- **Inputs / Outputs:** final reply → `messages` row: `sent_by:'ai'`, `quality_score`, `flagged: qualityFailing`, `flag_reason`, `external_message_id: graphMessageId ?? priorGraphMessageId ?? 'ai_'+uuid`, `product_ids` emptied when the reply was a holding/escalation replacement (so later turns cannot reuse products the customer never saw)
- **External calls / SQL / cache ops:** single INSERT; `external_message_id` is globally UNIQUE (migration 012)
- **Deterministic:** yes
- **Failure behavior:** throw→retry with two documented retry hazards (`persistence-delivery` §b): (i) crash-after-send retry with a real prior graph id → UNIQUE violation → job dead-letters with steps S-66…S-73 permanently unexecuted; (ii) WhatsApp (`'1'` marker) → retry inserts a **second** row under a fresh `ai_` uuid (duplicate row, single delivery). Also: an `alreadySent` retry has `sendResult === null`, so S-68 later marks the delivered message `send_status='failed'` with `'Contact not found for conversation'`.

### S-66 — Post-persist alerts (each its own transaction)
- **Where:** `processAIReply.ts:3218-3444`
- **Inputs / Outputs:** guard flags → alert rows referencing the outbound message id: `product_image_unavailable` (**no pause**, `:3218-3249`); `hallucinated_price` + pause (`:3255-3293`); `hallucinated_product_name` + pause (`:3298-3336`); `uncertain_answer_escalated` + pause + `human_replied=false` (`:3342-3381`); quality-flag alert (reason = stored flag reason) + pause + fire-and-forget auto `feedback_log` row (`:3383-3444`). Each emits `ai_alert` + `conversation_updated`
- **External calls / SQL / cache ops:** up to 5 independent BEGIN/COMMIT transactions; sockets
- **Deterministic:** yes (given flags)
- **Failure behavior:** each pair fail-open independently — a tx failure leaves the holding message delivered with **no pause/alert** (logged, e.g. `:3274-3278`); a crash between pairs leaves committed pauses that block the retry at S-19's `ai_paused` gate, permanently skipping S-67…S-73 for the turn.

### S-67 — Bookkeeping: touch, analytics, sockets, use-case eval enqueue
- **Where:** `processAIReply.ts:3446-3470`
- **Inputs / Outputs:** `touchConversationLastMessageAt`; `void logEvent('ai_reply_sent', …)`; sockets `new_message` + `conversation_updated`; `void aiQueue.add('evaluateConversationUseCase', …, { delay: 4h, jobId: 'eval-usecase-'+conversationId, removeOnComplete: true, removeOnFail: false })`
- **External calls / SQL / cache ops:** conversation UPDATE; analytics INSERT (fire-and-forget); BullMQ add (fire-and-forget). jobId dedup means the **first** reply's 4-hour timer wins (subsequent adds with an existing id are ignored — the in-code comment claiming the close-time delay-0 add "cancels" the delayed one inverts BullMQ semantics, `queueing` §4.4)
- **Deterministic:** yes
- **Failure behavior:** all fire-and-forget = silent-drop on failure. **Both the `ai_reply_sent` event and the use-case enqueue fire even when the channel send failed** (they precede S-68), contradicting CLAUDE.md §11's coupling claim.

### S-68 — Send-failure handling
- **Where:** `processAIReply.ts:3472-3508`
- **Inputs / Outputs:** `!sendResult?.success` → `updateMessageSendFailure(id, tenantId, 'failed', errReason)` (error truncated 2000 chars), socket `message_send_failed`, alert `message_send_failed`
- **External calls / SQL / cache ops:** message UPDATE; alert INSERT; sockets
- **Deterministic:** yes
- **Failure behavior:** terminal fail-open — because sends return failure values, the job **completes successfully**; BullMQ never re-attempts delivery. The failed row keeps `sent_by:'ai'` and still counts toward use-case billability (`aiUseCaseService.ts:259-264`, no send_status filter). On the `alreadySent`-retry path this branch runs with fallback reason `'Contact not found for conversation'` against a message that was actually delivered.

### S-69 — Draft order: intent detection + signals + phone/name resolution (LLM #27, #28, #29)
- **Where:** `processAIReply.ts:3510-3553` (block try/catch `:3510, 3831-3837`); `intentDetectionService.ts:112-155`
- **Inputs / Outputs:** last 40 messages + catalog product names → `{ is_ready_to_order, intent_score, product_name, delivery_address, customer_first_name, quantity }` on `OPENAI_INTENT_MODEL` (temp 0, json, 512 tok); re-runs `classifyNewOrderSignal` + `detectOrderAffirmationIntent` (`:3528-3531`); phone precedence: contact metadata → conversation regex scan → WhatsApp external id (`:3536-3545`); name via `resolveCustomerNameForOrder` with address-word rejection (`:200-253`)
- **External calls / SQL / cache ops:** 3 OpenAI calls; message SELECTs
- **Deterministic:** no (LLM)
- **Failure behavior:** empty intent response → throw; any throw in this block is swallowed by the catch (`'[ai.reply] Intent detection or draft order failed'`) — **fail-closed for order creation, silent** (customer already has the reply; the order is simply never created and never retried). No contact → silent-drop [E27].

### S-70 — Draft order: affirmation gate + validation gate
- **Where:** `processAIReply.ts:3555-3633` (gate verbatim `:3605-3612`)
- **Inputs / Outputs:** `passesDraftOrderValidation = is_ready_to_order && intent_score > INTENT_THRESHOLD (0.85) && product_name != null && hasDeliveryAddress && hasCustomerPhone && hasCustomerName && shouldAffirmOrder`; `shouldAffirmOrder = explicitNewOrder || (dataConfirmationSent && (latestAffirms || recentAffirmationAfterConfirmation || (detailsPayload && orderClosingAskedEarlier)))` — a "po/ok" counts only after the data-confirmation request; `hasAssistantAskedOrderClosingInConversation` re-invoked here on a fresh 40-message fetch (`:3575` — second unbounded LLM scan)
- **External calls / SQL / cache ops:** LLM scans per S-52's helper; structured `[ORDER_COLLECTION_STATE]` log
- **Deterministic:** conditional (gate arithmetic deterministic over LLM-derived inputs)
- **Failure behavior:** validation fail → silent-drop [E28] (reply already delivered; no order; log only).

### S-71 — Draft order: product resolution + ambiguity clarification
- **Where:** `processAIReply.ts:3641-3749`; resolver `orderProductResolutionService.ts:84-177`
- **Inputs / Outputs:** intent product name + customer's own last 4 messages → deterministic narrowing (unique → size → flavor → color → bare-number → intent-exact); ambiguous → one-time variant-clarification question (≤6 candidates) sent + persisted, no order; out-of-stock / no name / no catalog match → skip
- **External calls / SQL / cache ops:** product SQL (no LLM); clarification `sendMessage` + message INSERT — **no Redis idempotency marker, no send precheck**; duplicate suppression only via a scan of the last 8 messages for the clarification lead-in string (`:3679-3686`)
- **Deterministic:** yes
- **Failure behavior:** ambiguous → canned-reply exit [E29]; OOS [E30] / no name [E31] / unmatched [E32] → silent-drop (no order); errors swallowed by block catch.

### S-72 — Draft order: duplicate-order guards
- **Where:** `processAIReply.ts:3755-3786`; `order.ts:627-642`
- **Inputs / Outputs:** latest non-cancelled order for the conversation → skip when same product && !explicitNewOrder [E33], or different product but no new-order signal in the current message [E34]
- **External calls / SQL / cache ops:** order SELECT; no DB uniqueness constraint — dedup is these two application checks plus the conversation lock
- **Deterministic:** yes
- **Failure behavior:** silent-drop (no order).

### S-73 — Draft order: commission decision + `createOrder`
- **Where:** `processAIReply.ts:3788-3830`; window SQL `:501-541`; INSERT `order.ts:177-210`
- **Inputs / Outputs:** `quantity = max(1, intent.quantity ?? 1)`; `unitPrice = Number(matchedProduct.price)` (**`discounted_price` not consulted**); `isCommissionable = !hasHumanParticipationInCurrentOrderWindow(…)` — SQL window = later of (session start, gap `COMMISSION_SESSION_GAP_HOURS` default 3 h) and previous order's creation, over 30 days; `commissionAmount = Math.round(totalPrice * 0.05 * 100) / 100`; order INSERT with `status:'draft'`, `detected_by:'ai'`; `void logEvent('order_created')`; `socketService.emitOrderCreated`
- **External calls / SQL / cache ops:** one window SQL query; one INSERT; analytics + socket
- **Deterministic:** yes (given message timeline)
- **Failure behavior:** errors swallowed by the block catch (silent-drop of the order); no idempotency marker on `createOrder` — a hard-crash retry that re-reaches this point relies solely on S-72's guards.

### S-74 — finally: lock + slot release
- **Where:** `processAIReply.ts:3839-3846`
- **Inputs / Outputs:** conversation lock released (token-checked Lua), then tenant fairness slot decremented — on **every** exit path above
- **External calls / SQL / cache ops:** Redis Lua DEL + DECR
- **Deterministic:** yes
- **Failure behavior:** release errors caught; TTLs (300 s lock / 300 s slot counter) are the backstop against leaked locks.

---

## Retrieval design observations

Presence/absence checklist for the product-retrieval subsystem (observation only):

| Technique | Status | Evidence |
|---|---|---|
| Query rewriting | **Absent** for the general path — the raw trimmed burst text is the query (`aiService.ts:3544`, `embeddingService.ts:7`). **Partially** employed on special routes: other-options turns rewrite the query from an LLM `category_hint` / conversation anchor / persisted-product categories (`aiService.ts:3591-3649`); anchor extraction re-derives a query from prior non-follow-up customer messages (`productRetrievalService.ts:209-250`) |
| Query normalization | **Partially** — lexical paths lowercase/strip non-alphanumerics (`extractKeywords`, `aiService.ts:332-339`) and NFD-strip diacritics for phrases (`aiService.ts:344-350`); the **embedding** query gets no normalization at all (no lowercasing, diacritic folding, stop-word or punctuation handling — `aiService.ts:693`, `embeddingService.ts:7`); stored product text is likewise raw (`embeddingService.ts:35-63`) |
| Query expansion | **Partially** — anchor keyword expansion (up to 4 keywords ≥4 chars re-run through RRF, `productRetrievalService.ts:270-290`) and bigram/category phrase extraction (`aiService.ts:343-379`); no synonym/multilingual expansion, no LLM query expansion for the main path |
| Metadata filtering | **Partially** — hard SQL predicates only: `tenant_id`, `deleted_at IS NULL`, `is_active`, `embedding IS NOT NULL`, `embedding_model` guard (`product.ts:781-791`); no attribute/category/price filters applied to semantic search; category filtering exists only as a separate lexical source (`searchProductsByCategoryOrTag`, `product.ts:641-662`) |
| Hybrid retrieval | **Employed** — 4-source weighted RRF (semantic 2.0 / category_tag 1.5 / phrase_direct 1.2 / keyword 1.0, `RRF_K = 60`; `aiService.ts:431-448, 677-762`), with the conditional rule that category-shopping intent **drops the semantic source entirely** when category/tag matches exist (`aiService.ts:723-736`) |
| Reranking | **Absent** for text retrieval (RRF rank order is final; no cross-encoder/LLM reranker). **Employed** in the image pipeline only: vision re-rank of ambiguous visual matches when top-2 similarity gap ≤ 0.04 (`productImageMatchingService.ts:303-372`) |
| Adaptive top-K | **Partially** — K is not adaptive to the query, but selected per turn type: 10 focused (`aiService.ts:82`) / 25 category-group (`productRetrievalService.ts:13`) / 20 alphabetical fallback (`aiService.ts:290`); the ANN candidate pool is adaptive (ef_search 100 → one retry at 500 when under-filled, `product.ts:804-814`) |
| Retrieval confidence scoring | **Partially** — semantic similarity is thresholded in JS (`SIMILARITY_THRESHOLD` 0.65, `aiService.ts:703-709`) and image similarity in SQL (0.62, `productImageFingerprint.ts:292`), and the image path computes a composite match confidence with a decision ladder (`productImageMatchingService.ts:440-456`, `productImageMatchPolicy.ts:191-266`); fused text results carry **no** confidence — lexical hits have no relevance floor and RRF scores are discarded after ranking |
| Grounding verification | **Employed post-hoc, not at retrieval time** — the reply (not the retrieval) is verified: deterministic price check vs catalog set (`priceConsistencyGuard.ts`), LLM product-name validation (`aiService.ts:3381-3444`), prompt-level hidden-count/zero-match guardrails (`aiService.ts:2046-2060, 2111-2123`); no verification that retrieved products are relevant to the query before injection |
| Context completeness validation | **Partially** — the product-information-gap path validates that the answer covers the requested attributes (`assessProductInformationRequest`, fail-closed, `productInformationGapService.ts:79`; deterministic `computeMissingStructuredAttributes` net, `processAIReply.ts:2345-2349`) and the zero-hit self-heal detects embedding-coverage gaps (`aiService.ts:3740-3765`); there is no general check that the retrieved set is complete for the query (e.g. category turns cap at 25 with only a "hidden count" note) |

---

## LLM call census

Every OpenAI call a **single inbound message** can trigger (main pipeline; excludes admin/import/fine-tuning). "Fallback class": `open` = failure lets the reply proceed unguarded; `closed` = failure escalates/blocks; `kw` = keyword/regex fallback substitutes; `throw` = propagates (job retry). All classifier calls use `temperature: 0` + `response_format: json_object` unless noted; all run on the SDK singleton (maxRetries 3, timeout 60 s).

| # | Call | Model | max_tok | When | Fallback |
|---|------|-------|---------|------|----------|
| 1 | `detectReplyLanguage` | CHAT | 32 | every text turn (heuristic skip) | open (heuristic → 'sq') |
| 2 | `detectCancellationOrRefundIntent` | CHAT | 200 | every turn | open (umbrella catch) |
| 3 | `detectWrongProductIntent` | CHAT | 200 | every turn | open |
| 4 | `classifyNewOrderSignal` | CHAT | 64 | every turn (×2: pre-reply + draft-order) | kw |
| 5 | `detectOrderAffirmationIntent` | CHAT | 180 | every turn (×2) | open (no confidence boost) |
| 6 | `detectPostPurchaseSupportIntent` | CHAT | 240 | regex-cued only | open |
| 7 | `detectOrderInfoUpdateIntent` | CHAT | 350 | unless order-signal/affirmation | open |
| 8 | `classifyProductImageRequest` | CHAT | 96 | regex pre-screen; parallel | open (null) |
| 9 | `customerAskedAboutPrice` | CHAT | 64 | every turn (parallel) | kw |
| 10 | `customerAskedAboutDiscount` | CHAT | 64 | every turn (parallel) | kw |
| 11 | `classifyProductAttributeIntent` | CHAT | 128 | every turn ≥2 chars (regex fast-path) | kw |
| 12 | `classifyOtherProductOptionsIntent` | CHAT | 64 | pre-screened turns | kw |
| 13 | `classifyContextualProductFollowUp` | CHAT | 16 | rare empty-retrieval path | closed (false) |
| 14 | Query embedding (`embeddings.create`) | EMBED | n/a | every turn (256-entry cache; 1–3 per turn across retrieval retries) | open (null → lexical-only) |
| 15 | `isConversationEnding` | CHAT | 64 | every turn (regex fast-path) | open (false) |
| 16 | **Main reply completion** | custom_model_id \|\| CHAT; VISION on image turns | **768**, temp 0.3 (≤0.3 on uncertain images), no seed/response_format | every replying turn | **throw** (empty → job retry) |
| 17 | `classifyUsageQuestionIntent` | CHAT | 64 | every non-empty turn | kw |
| 18 | `isUsageQuestionUnanswered` | CHAT | 64 | usage turns (may run ×2) | open (caller catch) |
| 19 | `detectSpecifiedAttributes` | CHAT | 120, **6 s abort**, 5-min cache | info-gap path | open (empty set) |
| 20 | `assessProductInformationRequest` | CHAT | 400 | info-gap path | **closed** (escalates) |
| 21 | `classifySpeculativeHealthAdvice` | CHAT | 64 | usage turns (keyword fast-path) | open |
| 22 | `classifyOrderConfirmationReplyIntent` | CHAT | 96 | non-escalated turns | kw |
| 23 | `classifyOrderClosingQuestionReplyIntent` | CHAT | 64 | **per assistant message the regex misses**, in two scans per job (`processAIReply.ts:2597, 3575` → `:740-751`) — up to ~40 calls | kw |
| 24 | `classifyFollowUpInvitationInReply` | CHAT | 64 | non-order-confirmation replies | open |
| 25 | `classifyNegativeAvailabilityReply` | CHAT | 64 | every final reply | kw |
| 26 | `evaluateReply` (quality) | **EVAL** | 256 | unless skip-path (synthetic 0.95) | open (null) |
| 27 | `classifyOrderDetailsCollectionReplyIntent` | CHAT | 96 | only when a quality flag would fire | kw |
| 28 | `filterHallucinatedProductNames` | CHAT | 128 | matched products present | open ×2 |
| 29 | `detect` (purchase intent) | **INTENT** | 512 | after every sent reply | closed for orders (throw → swallowed) |
| 30 | `extractCustomerProductFromImages` | **VISION** | 750 | per attached image (1 h Redis cache) | throw to caller |
| 31 | `rerankAmbiguousVisualMatches` | **VISION** | 120 | ambiguity gap ≤ 0.04 | open (vector order) |
| 32 | Fingerprint-text query embedding | EMBED | n/a | per image | open (visual search skipped) |

**Counts per inbound message** (from `classifiers.md` and orchestration §5):
- **Minimum** (early exit before language detection — gates/staleness/reaction/emoji): **0** LLM calls. Minimum for a normally answered text turn: **~15–20** (pre-reply detectors + generateReply's internal classifiers + embedding + main completion + always-on guard classifiers).
- **Typical** answered text turn: **~20–25** calls, serialized except the two parallel groups (S-30, S-32).
- **Maximum** (worst-case text turn, all conditional guards + draft-order stage): **~28–33** fixed sites, plus up to **~40** from the two per-assistant-message order-closing scans (#23) → **~70 calls reachable for one text message**; an image burst (up to 5 attachments) adds **~10–15** vision/embedding calls on top.
- The design does not employ cross-call batching, a shared classification call, or per-conversation caching of classifier results (only the in-process query-embedding cache and the 5-min attribute-availability cache exist). Only 2 classifier sites honor dedicated model env vars (`OPENAI_INTENT_MODEL`, `OPENAI_EVAL_MODEL`); the tenant `custom_model_id` applies solely to the main non-vision reply.
