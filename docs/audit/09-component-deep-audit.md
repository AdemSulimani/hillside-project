# Phase 9 — Component Deep Audit

> **Banner.** This deliverable collates ten paired component audits (20 auditor domains, 21 report sections) run against the working tree at branch `main`, commit `a8ceb15`, on 2026-07-12. It is a **quality** pass — observations only, no fixes. Every finding carries `file:line` evidence, severity (S0 worst … S3 minor), and confidence (H/M/L). Prior-phase findings (registered as **DP-nn** in `register/merged.json`, **EV-nnn** in the evidence log, **S-NN** in the step-ledger, or established in Phase reports 01–08 / WF-A–E) are retained here as **one-line links, not re-derived**. Findings marked **NEW** are spelled out in full and are consolidated in the *New findings* section that feeds Phase 11. Registry of all 152 findings: `scratchpad/audit/component-registry.json`.
>
> **Rollup:** 152 findings — **0 S0 · 30 S1 · 96 S2 · 26 S3** · **53 NEW**. Two systemic threads dominate: (1) the whole AI runtime is inlined into two files (`processAIReply.ts` ~3,847 lines / `aiService.ts` ~4,296 lines), so orchestration, billing, and guard ordering are positional code with zero test coverage; and (2) the pervasive **"return success on failure"** anti-pattern (swallowed throws, non-throwing sends, fail-open transactions, fresh-attempt reschedules) makes most customer-facing failures silent by construction — the mechanical substrate of Issue 1 (divergent outcomes on identical input) and Issue 2 (mechanically false escalations).

---

## Domain audit

### Architecture

The intended layering (`routes → middleware → controllers → services → db/models`, CLAUDE.md §5) is inverted on the most important flow: the AI reply pipeline *is* a BullMQ job file, and the second-most-important logic lives in one 4,296-line god-service. There is no modeled conversation state machine and no shared "assemble prompt / send reply" service — the same operation is re-implemented three times with drifting fidelity, and lifecycle policy leaks into raw-SQL upserts.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-01 (A1) | **NEW** — Entire AI reply pipeline (concurrency, ~10 escalation paths, guard chain, send, draft-order + commission) lives in a 3,847-line job, not a service; guard ordering is load-bearing positional code | S2 | H | `jobs/processAIReply.ts:1148` | S-14..S-74, DP-GPR-28, DP-po-18 |
| C-02 (A2) | **NEW** — `aiService.ts` fuses retrieval, prompt assembly, ~20 classifiers, generation, and hallucination filters at file scale; the name-guard and the retrieval that grounds it live in the same module | S2 | H | `services/aiService.ts:614-4132` | S-31..S-42, DP-gg-31, EV-011/013/015 |
| C-03 (A3) | **NEW** — Three divergent homes for assemble-prompt/send-reply: job (temp 0.3), human-reply inline in controller, admin "test" inline (temp 0.7, empty-query catalog dump); "mirror the production path" comment already false | S2 | H | `controllers/adminAiController.ts:320-349` | A6, B6, DP-pc-01/02/08 |
| C-04 (A4) | No modeled conversation state machine; lifecycle across 4 columns + Redis + BullMQ, writers in 3 controllers + 13 job sites | S2 | H | `jobs/processAIReply.ts` | Phase05 T1–T12, WF-D dead-ends, DP-iq-15 |
| C-05 (A5) | Lifecycle policy encoded in db/models SQL: reopen upsert forces `status='open'` but never touches `ai_paused` (T9 reopened-but-paused) | S2 | M | `db/models/conversation.ts:28-48` | Phase05 T9 |
| C-06 (A6) | **NEW** — Controllers reach into queue via `as unknown as` cast and duplicate the `jobId` dedup literal verbatim (two owners of one invariant) | S3 | M | `controllers/conversationController.ts:218-227` | A1, S-67 |

### Backend

Input-validation coverage is strongest on authenticated internal routes and absent exactly where inputs are untrusted (webhooks). An Express 5 footgun means "validation passed" does not guarantee the controller sees the coerced value. The most safety-critical AI switch has the weakest request contract, dead 403-stubs advertise capabilities that don't exist, and the error envelope leaks raw payloads for non-`Error` throws in production.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-07 (B1) | **NEW** — `validate` middleware never rewrites `req.query`/`req.params` (Express 5 read-only getter); controllers reading `req.query.x` directly get raw uncoerced values with Zod defaults/coerce bypassed — platform-wide footgun | S2 | H | `middleware/validate.ts:38-44` | S-01 |
| C-08 (B2) | **NEW** — AI global on/off `PATCH /toggle` has no validation and no desired-state contract; blind `!is_active` flip races two concurrent requests to opposite states | S2 | M | `controllers/chatbotControlController.ts:21-41` | Phase05 T7, S-17 |
| C-09 (B3) | **NEW** — Dead 403-stub endpoints (`aiConfig` PUT `/`, POST `/test`) registered without validators; advertise write/test capabilities that unconditionally 403 | S3 | H | `routes/aiConfig.ts:11-12` | A3, B6 |
| C-10 (B4) | Response-envelope inconsistency across list endpoints; `chatbotControl.pausedConversations` returns a bare unbounded list with no pagination | S3 | H | `controllers/chatbotControlController.ts:71-80` | CLAUDE.md §5/§11 |
| C-11 (B5) | Zero schema validation on webhook ingestion; payloads hand-parsed with first-element-only assumptions | S2 | H | `services/processInboundMessage.ts:434-455` | S-03/06/07, DP-iq-15 |
| C-12 (B6) | **NEW** — Admin "test AI" exercises a different system than production (temp/tokens/no response_format/empty-query retrieval/no guards) — cannot reproduce a real reply; gives false confidence | S2 | H | `controllers/adminAiController.ts:295-361` | A3, EV-025, DP-gg-31 |
| C-13 (B7) | **NEW** — `sendError` attaches the raw `error` object to the JSON response for any non-`Error` throw in **every** environment; PG driver errors / thrown strings can surface SQL fragments to clients | S2 | M | `utils/response.ts:28-36` | CLAUDE.md §9 |

### Frontend

The resume *control* is reachable for every paused conversation, so report-05's six dead-ends are a backend auto-resume gap, not a control-reachability gap. The frontend defects are about discoverability and contradictory state rendering: two adjacent widgets display opposite AI states, the recovery surface is mislabeled as manual-only, the default alert action manufactures a dead-end, and `order_updated` has no listener at all.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-14 (FE-1) | **NEW** — Two contradictory AI-paused indicators in one footer: StatusBar keys off sticky `ai_paused`, ReplyBox off transient `human_override_until` — they can show opposite states for the same conversation | S2 | H | `pages/inbox/InboxPage.tsx:765-774` | Phase05 dead-end #1/#3 |
| C-15 (FE-2) | **NEW** — "Paused conversations" list copy says manual-only, but the query is `WHERE ai_paused=true` — it also lists escalation/rate-limit/reopened pauses, hiding the dead-ends in plain sight | S2 | H | `pages/chatbotControl/ChatbotControlPage.tsx:225-227` | Phase05 #1/#2/#6, T7 |
| C-16 (FE-3) | Default largest "Close alert" action fires `resume_ai:false` → manufactures dead-end #3 (alert resolved, `ai_paused` stays true) | S2 | H | `pages/aiAlerts/AIAlertsPage.tsx:330-332` | Phase05 dead-end #3 |
| C-17 (FE-4) | No proactive signal for rate-limit-paused (#2) / reopened-but-paused (#6); banners key strictly off `open_ai_alert` | S2 | M | `pages/inbox/InboxPage.tsx:636-698` | Phase05 dead-ends #2,#6 |
| C-18 (FE-5) | `order_updated` socket event emitted by backend has zero frontend listeners; order status transitions stay stale until refetch | S2 | H | `services/socketService.ts:71` | mapper D.5 |
| C-19 (FE-6) | Human-hold window hardcoded client-side (`10*60*1000`), diverges from env-tunable `HUMAN_HOLD_MINUTES` | S3 | H | `pages/inbox/InboxPage.tsx:52-54` | mapper D.2 |
| C-20 (FE-7) | Viber second-class in AI surfaces: no inbox filter tab; alert toast coerces `viber`→`facebook` | S3 | H | `hooks/useAiAlertToast.ts:39-44` | mapper F.5 |
| C-21 (FE-8) | **NEW** — Feedback form invalidates `['ai-config']` though feedback writes only `feedback_logs`; spurious refetch + false implication that a correction changes AI now | S3 | M | `components/inbox/AiMessageFeedbackForm.tsx:44` | CLAUDE.md §6 |

### AI Pipeline

The one customer-facing completion is an unmanaged stochastic root, and the 26–33K-char system prompt around it is unbudgeted, uncached, un-versioned, and carries an orphan block instructing the model to trust a section no code emits. Nothing stamps which prompt produced a reply, so divergence is un-forensic; most tenants may run with no business rules in-prompt at all.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-22 (AP-1) | Single customer completion passes only `{model,messages,temperature,max_tokens:768}` — no seed/top_p/response_format; every guard validates a fresh sample | S1 | H | `services/aiService.ts:4118-4124` | DP-gg-01, EV-025 |
| C-23 (AP-2) | **NEW** — No prompt versioning/provenance: assembled from mutable blocks + ~13 appends, no prompt hash on `messages`, `ai_config_versions` unlinked; the exact input behind any reply is unreconstructable | S2 | H | `services/aiService.ts:3919-4092` | DP-pc-01/02/04/08 |
| C-24 (AP-3) | 26–33K-char system prompt unbudgeted/uncached, re-sent verbatim every turn; `systemPromptTokenEstimate` computed and never read | S2 | H | `services/aiService.ts:4003` | DP-pc-20 |
| C-25 (AP-4) | Orphan `offers_promotions` block (catalog-inactive, tenant-enabled) injects a directive to trust a nonexistent "Active offers" section (0 code matches) | S2 | H | `services/promptAssemblyService.ts:89` | DP-pc-19 |
| C-26 (AP-5) | Competing "HIGHEST PRIORITY" declarations + ~13 stacked appends after guidelines; migrations 064/065/067 document removing contradictions one at a time | S2 | M | `services/productDescriptionPromptService.ts:196` | migrations 064/065/067 |
| C-27 (AP-6) | Unfiltered history; AI and human both map to `assistant`; older-context summary injected as a 2nd system message — memory contamination | S2 | H | `services/aiService.ts:3115-3128` | DP-pc-14 |
| C-28 (AP-7) | Locked-block force-sync UPDATE runs on the hot reply path every `generateReply`; reverts admin customizations silently | S2 | H | `services/aiService.ts:239-251` | DP-pc-08 |
| C-29 (AP-8) | `buildRestrictionsFooter` emits nothing when both arrays empty; Phase 7: footer populated for 1/6 tenants, `platform_restrictions` never rendered — most tenants may run with no business rules in-prompt | S1 | M | `services/aiService.ts:2306-2328` | Phase7 WF-D |
| C-30 (AP-9) | Token accounting heuristic (chars/4) and internally inconsistent add-vs-remove estimates at the 6000-token knife-edge | S3 | M | `services/aiService.ts:4006-4023` | DP-pc-12/13 |

### Conversation

There is no durable conversation/order state — order-collection slots are re-derived every turn from a 40-row transcript window, and the only "memory" beyond 10 recent rows is a summarizer that discards every assistant turn, price, and order detail. Any fact that scrolls out of the window is unrecoverable, and the product anchor is emptied precisely on the turns that carry the most state.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-31 (C1) | Deterministic summarizer keeps only customer-message previews; drops every assistant price/recommendation/ETA/order detail | S2 | H | `services/aiService.ts:3049-3090` | DP-pc-10, 04-audit Q5 |
| C-32 (C2) | History budget excludes the (larger) system prompt + inbound so it can't bound context; `length/4` under-counts Albanian | S2 | H | `services/aiService.ts:4019-4023` | DP-pc-12/13 |
| C-33 (C3) | No durable slot/state store; intent re-extracts product/qty/address/name every turn from the transcript | S2 | H | `services/intentDetectionService.ts:102-157` | DP-pc-09, DP-retrieval-12/13 |
| C-34 (C4) | `product_ids` anchor persisted `[]` on order/holding/escalation turns; rehydration filters `is_active` and silently shrinks the set | S2 | H | `jobs/processAIReply.ts:3211` | DP-retrieval-12/13, EV-019 |
| C-35 (C5) | History `SELECT` unfiltered — flagged, failed-to-send, and human rows all re-enter as `assistant` context | S2 | H | `db/models/message.ts:304-321` | DP-pc-14, EV-022 |
| C-36 (C6) | Burst-merge appends a duplicated user turn; random-UUID tiebreak reorders same-tick bursts | S3 | M | `services/aiService.ts:3147-3180` | DP-pc-15, DP-pc-11 |

### RAG

Whether semantic retrieval runs at all is a per-worker / per-latency coin-flip, and a single unset embedding-model env var silently disables all semantic search forever. The threshold is a hysteresis-free JS post-filter on the top-weighted source, category-intent is a binary mode switch, and RRF fusion has no deterministic tiebreak — retrieval instability lands directly on a stochastic generator.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-37 (R1) | Dimension landmine: default `text-embedding-3-large` (3072-d) + no `dimensions` param cannot write `vector(1536)`; query error swallowed → silent lexical-only forever; CLAUDE.md documents the *incompatible* default | S1 | H | `services/embeddingService.ts:12-15` | DP-retrieval-22 |
| C-38 (R2) | Non-aborting 5s embedding race + per-process FIFO cache (not LRU) + burst-text cache key → semantic runs or not by worker/latency; self-amplifying `semanticSkipped` | S1 | H | `services/aiService.ts:650-664` | DP-retrieval-01/02/03/23, EV-025 |
| C-39 (R3) | **NEW** — Adaptive `ef_search` escalates only when `firstPass.length < limit`, so it recovers *missing* rows but never *wrong* rows; large tenants silently get `limit` wrong products with no recovery, worsening with corpus growth | S2 | M | `db/models/product.ts:811-812` | DP-retrieval-07/08 |
| C-40 (R4) | `SIMILARITY_THRESHOLD` a hysteresis-free JS post-filter on the top-RRF-weight source; documented 0.65/0.75 drift; internally inconsistent vs SQL-side image floor | S2 | M | `services/aiService.ts:703-709` | DP-retrieval-04/05 |
| C-41 (R5) | Category-intent semantic drop is a binary 0-vs-1 mode switch on `categoryTagMatches.length`, not a down-weight; one tag edit flips retrieval regime | S2 | M | `services/aiService.ts:725-736` | DP-retrieval-06 |
| C-42 (R6) | RRF fusion has no deterministic tiebreak (heap-order ties) and double-counts phrase-direct duplicates, inflating fused scores | S2 | M | `services/aiService.ts:431-448` | DP-retrieval-11 |
| C-43 (R7) | No embedding-input normalization; single whole-product vector, no chunking/length cap; most exposed to WF-E Albanian degradation | S3 | M | `services/embeddingService.ts:7` | retrieval-mapper §3.5, WF-E |
| C-44 (R8) | Main completion no seed/response_format, temp 0.3 — converts retrieval coin-flips into user-visible divergence | S2 | H | `services/aiService.ts:4118-4124` | S-42 |

### Data Access

SQL is cleanly parameterized (no injection surface), but the hot AI-context history query has no covering index for its ordering and runs without a tenant predicate. The globally-unique `external_message_id` is a cross-tenant collision root, the HNSW adaptive-recall re-scans on every small-tenant query, and duplicate `062` migration prefixes break the numbering contract.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-45 (DA-1) | **NEW** — Main AI-context history query orders `created_at DESC, id DESC` but no index covers `(conversation_id, created_at DESC, id DESC)`; planner can backward-scan the global `created_at` index — bad-plan latency spike under load, called 4–5×/reply | S2 | M | `db/models/message.ts:309-318` | data-model mapper §5/§7 |
| C-46 (DA-2) | **NEW** — `findMessagesByConversation` filters `conversation_id` only, no `tenant_id`; the single most sensitive unscoped read, feeds LLM context from BullMQ payloads (a tenant-scoped sibling exists but is unused) | S3 | M | `db/models/message.ts:304-319` | CLAUDE.md §5 |
| C-47 (DA-3) | `messages.external_message_id` is globally `UNIQUE` (no `tenant_id`); cross-tenant dedup collision + crash-after-send dead-letter | S1 | H | `migrations/012_create_messages.sql:5` | DP-po-09/10/11, DP-iq-11 |
| C-48 (DA-4) | **NEW** — Two `062_*` migration files; runner orders by full filename, so numbering no longer encodes total order — latent divergent evolution between prod and fresh bootstrap | S3 | H | `db/migrations/062_*.sql` | data-model mapper §2 |
| C-49 (DA-5) | HNSW adaptive recall runs a full 2nd ANN scan (`ef_search=500`) on every query for any tenant with < `limit` embedded products (most new tenants) | S2 | M | `db/models/product.ts:804-814` | DP-retrieval-01/03 |
| C-50 (DA-6) | Human-reply writes multi-statement/non-atomic; in-app path never sets sticky `human_replied` — billing disqualification depends on echo-vs-persist race | S2 | M | `controllers/conversationController.ts:162-193` | DP-iq-11/12 |
| C-51 (DA-7) | `id DESC` tiebreak is a random UUID; same-timestamp burst messages order non-chronologically in AI context | S3 | L | `db/models/message.ts:314` | DP-pc-11 |
| C-52 (DA-8) | *(Positive/hygiene)* Parameterization clean; sole non-param fragment is numeric-guarded `SET LOCAL hnsw.ef_search` | S3 | H | `db/models/product.ts:781` | data-model mapper §8 |

### Cache

Four prompt-assembly caches use delete-only invalidation with a refill-resurrection race, so two workers can assemble different guidelines — even a different chat model — for the same tenant state. Reply-critical Redis calls are not error-guarded (a flap silences the whole job), one mutation path forgets to invalidate, and two in-process caches are unbounded / incoherent across workers.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-53 (CA-1) | Delete-only invalidation + refill-resurrection race across the 4 prompt caches; `custom_model_id` rides the 900s-cached config → workers can pick different models | S2 | H | `services/aiService.ts:201-306` | DP-pc-01/02/03/04 |
| C-54 (CA-2) | Reply-critical Redis `get/set` guarded only around `JSON.parse`, not the Redis call; a Redis flap throws → whole `ai.reply` job fails → silence (stats path fails open, reply path does not) | S1 | H | `services/aiService.ts:203-304` | DP-pc-07 |
| C-55 (CA-3) | Tenant global-AI toggle mutates `ai_configs` without invalidating `ai_config:` cache; stale persona/model for ≤900s | S2 | H | `controllers/chatbotControlController.ts:31` | DP-pc-01 |
| C-56 (CA-4) | Onboarding config creation can't displace a pre-cached `DEFAULT_AI_CONFIG` (unrestricted persona for up to 900s) | S3 | M | `services/aiService.ts:219-228` | DP-pc-06 |
| C-57 (CA-5) | `self_send_echo` 600s TTL + swallowed writes misclassify AI's own echo as a human agent → sticky `human_replied` + hold + use-case billing loss | S1 | H | `services/outboundEchoRegistry.ts:27-57` | DP-iq-11/12 |
| C-58 (CA-6) | Locked-block self-heal awaited UPDATE on every reply: failure fails the reply; success + CA-1 race opens a per-worker divergence window | S2 | M | `services/aiService.ts:243-245` | DP-pc-08 |
| C-59 (CA-7) | **NEW** — In-process `availabilityCache` `Map` has no size cap and never deletes expired entries (only skips on read); keys embed `updated_at` so every catalog edit mints an unreclaimed key → monotonic memory growth / OOM | S3 | M | `services/productAttributeAvailabilityService.ts:44` | caching mapper B.2 |
| C-60 (CA-8) | No cross-worker coherence channel for in-process caches or ~20 module-frozen env constants; workers under different env run divergent thresholds/models permanently | S3 | M | `services/aiService.ts:75` | DP-retrieval-01/03/23 |
| C-61 (CA-9) | Send-idempotency markers (`EX 3600`) expire before self-rescheduled retries fire → duplicate outbound on the retry tail | S3 | M | `jobs/processAIReply.ts:3104` | DP-po-09/10/11 |

### Tooling

No structured-output contract exists anywhere: 33 classifier calls rely on `json_object` + hand-rolled parsing, and the scale-guessing `>1?/100` normalization silently collapses overconfident outputs by 100×. Failure handling is non-uniform (fail-open / fail-closed / throw), so one OpenAI blip degrades neighboring guards in contradictory directions, and the product-import service bypasses the singleton entirely.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-62 (T1) | No `json_schema`/tool-calling/seed anywhere; 33 classifiers hand-parse `json_object` — correctness depends on the model volunteering the right keys/types every call | S1 | H | `services/aiService.ts:133-143` | DP-po-17/19, DP-GPR-16 |
| C-63 (T2) | **NEW** — `parseModelClassifierConfidence`/`parseIntentJson` guess scale via `raw>1?raw/100:raw`; an overconfident `1.5`/`2` collapses to ~0.02, and `"85"`→`0.85` fails the strict `>0.85` order gate | S2 | M | `services/intentDetectionService.ts:52-54` | DP-po-17 |
| C-64 (T3) | Non-uniform parse-failure handling across sites (fail-open / fail-closed / throw); `extractCustomerProductFromImages` does a raw `JSON.parse` unguarded | S2 | H | `services/productImageFingerprintService.ts:139-141` | DP-gg-14, DP-po-18/19 |
| C-65 (T4) | Adjacent guards on one event fail in opposite directions (gap assessor fail-closed vs attr/pre-reply fail-open); no circuit breaker mediates | S1 | H | `jobs/processAIReply.ts:1942-1948` | DP-gg-14/16, DP-GPR-28 |
| C-66 (T5) | No per-classifier latency budget / circuit breaker; ~30 sites inherit the singleton 60s×3; a per-history-message LLM loop can push a turn to minutes | S2 | H | `services/openaiClient.ts:15-29` | DP-01, DP-03 |
| C-67 (T6) | **NEW** — `AIProductProcessingService` constructs its own `new OpenAI()` (no retries/timeout, fallback `gpt-4o-mini` vs singleton `gpt-4o`), `parseResponse` fails open to `[]` — silent catalog-import loss degrades all later retrieval | S2 | H | `services/AIProductProcessingService.ts:34-35` | classifiers mapper #1 |
| C-68 (T7) | ~28 of ~30 classifiers hard-route to `OPENAI_CHAT_MODEL`; `.env.example` ships `gpt-4o-mini` + `QUALITY_THRESHOLD=0.6`, diverging from code defaults | S2 | M | `services/openaiClient.ts:31-38` | DP-po-22 |
| C-69 (T8) | **NEW** — Admin sandbox completion runs temp 0.7, no `response_format`, none of the 60+ guards; a misleading verification surface that can pass content the live pipeline would strip | S3 | M | `controllers/adminAiController.ts:341-349` | classifiers mapper #33 |

### Intent

The purchase-intent subsystem stacks a double 0.85 knife-edge behind a 7-conjunct gate, five conjuncts derived from a single stochastic run, so identical order-ready turns flip order/no-order — and every miss is a silent `return`. The confidence-boost quirk rescues only exact zero and is applied asymmetrically, the money rule is decided post-send at a wall-clock instant, and a swallowed throw forfeits orders + commission with a green job.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-70 (I1) | Confidence-boost DP-GPR-16 rescues only exact `===0` (low-confidence still fails `>0.8`); order-affirmation detector has *no* boost → same model quirk over-fires escalation, under-fires orders | S2 | H | `services/aiService.ts:2509-2511` | DP-GPR-16 |
| C-71 (I2) | Order creation needs two model signals both pivoting at 0.85; `>1?/100` makes `"85"`→`0.85` fail the strict `>` gate — doubled flip surface | S2 | H | `jobs/processAIReply.ts:3605-3607` | DP-po-17/22 |
| C-72 (I3) | 7-conjunct draft-order gate (5 LLM-derived) multiplies flip probabilities; `explicitNewOrder` bypasses data-confirmation + duplicate guard | S2 | H | `jobs/processAIReply.ts:3605-3612` | DP-po-30/21 |
| C-73 (I4) | Commission eligibility computed post-send at a `NOW()`-relative session boundary; the revenue rule is the least deterministic step | S1 | H | `jobs/processAIReply.ts:3788-3830` | DP-po-28/26 |
| C-74 (I5) | **NEW** — Intent prompt is internally contradictory (line 120 "above 0.75" vs line 131 "above 0.85") and specifies no numeric range, worsening boundary noise where the strict gate lives | S2 | M | `services/intentDetectionService.ts:119-133` | DP-po-17/22 |
| C-75 (I6) | `INTENT_THRESHOLD` accepted only `>0 && <1`, silently reverts otherwise with no log; absent from `.env.example` → drifts between instances | S3 | M | `jobs/processAIReply.ts:3523-3527` | DP-po-22 |
| C-76 (I7) | Whether an intent LLM runs (and its failure behavior) hinges on standard-Albanian regex; Gheg phrasing slips the cue → classifier never invoked | S2 | H | `jobs/processAIReply.ts:1598` | DP-GPR-22, WF-E EV-010 |
| C-77 (I8) | Purchase-intent throw swallowed by the draft-order catch → no retry, order + 5% commission silently forfeited, job green | S1 | H | `jobs/processAIReply.ts:3831-3837` | DP-po-18/19 |

### Async

Every fairness/lock/human-hold deferral re-`add`s a *fresh* job with a fresh attempts counter, so the 3-attempt budget is effectively unbounded and reschedule loops are invisible to the debounce. The debounce's own `existingJob.remove()` is unguarded and can lose the AI job entirely, and non-idempotent side effects (acks, alert inserts, counters, the billing snapshot INSERT) re-execute on retry.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-78 (A1) | **NEW** — Debounce `getJobs(['delayed','waiting'])→find→remove()` throws if a worker promoted the job to active; the throw fails the webhook job, retry short-circuits on global dedup, the `ai.reply` add is never reached → artifact-free silence (concrete DP-iq-15 trigger); also removes at most one job; full-queue scan per inbound | S1 | H | `jobs/processInboundMessage.ts:886-907` | DP-iq-15 |
| C-79 (A2) | Self-rescheduling adds fresh jobs with no `jobId` and fresh attempts; comment claims jobId inheritance the code doesn't implement → unbounded retry budget | S2 | H | `jobs/processAIReply.ts:1164-1171` | DP-iq-19/20/25 |
| C-80 (A3) | **NEW** — Tenant fairness slot `EXPIRE 300` set once on first INCR, never renewed; a ~28–70-call run can exceed 300s → cap resets mid-flight and the `finally` DECR drives the counter negative, corrupting the cap until restart | S2 | M | `jobs/processAIReply.ts:1153-1190` | DP-iq-19 |
| C-81 (A4) | Non-idempotent side effects re-execute on retry: canned cancel/refund ack (no marker), alert inserts, rate-limit INCR; attachment re-upload orphans objects | S2 | H | `jobs/processAIReply.ts:1419-1422` | DP-po-09/10/11 |
| C-82 (A5) | `monthlyUseCaseSnapshot` "Upsert" comment vs plain `INSERT` (no `ON CONFLICT`) under attempts:3; a mid-loop throw retries the whole job → duplicate `commission_reports` rows | S2 | H | `db/models/commissionReport.ts:49-68` | seed billing snapshot |
| C-83 (A6) | Rate-limit INCR runs before enablement gates + stale guard; retries/stale/disabled jobs consume reply budget → 25/h cap non-deterministic | S2 | H | `jobs/processAIReply.ts:1231-1236` | DP-iq-21 |
| C-84 (A7) | **NEW** — Shared `jobId: eval-usecase-{id}` means BullMQ ignores the delay-0 close-time add (opposite of the comment) → billing eval deferred the full 4h even after explicit close | S3 | H | `jobs/processAIReply.ts:3459-3470` | queueing §4.4 |
| C-85 (A8) | Conversation lock TTL (300s) decoupled from BullMQ job lock (30s); a hard crash leaves the Redis lock up to 5 min → reschedule storm then silence | S2 | M | `jobs/processAIReply.ts:1197-1213` | DP-iq-20 |

### Reliability

The dominant anti-pattern is "return success on failure": swallowed throws, non-throwing sends, fail-open transactions, and fresh-attempt reschedules all conspire so BullMQ almost never sees a real failure — which is why there is effectively no DLQ safety net. There is no DLQ anywhere, the `notifications` queue is dead, and the stall-misclassification means the worst failures are the quietest.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-86 (R1) | Non-aborting 5s embedding "timeout" keeps running to 60s×3 and never caches timed-out text → semantic retrieval a per-worker coin-flip, self-amplifying | S2 | H | `services/aiService.ts:650-664` | DP-retrieval-01/03/23 |
| C-87 (R2) | No DLQ; exhausted `ai.reply` produces no alert and no reply; `notifications` queue is a no-op placeholder with zero producers | S2 | H | `jobs/failureHandler.ts` | queueing §8, seed |
| C-88 (R3) | **NEW** — `isPermanentlyFailed` infers exhaustion from `attemptsMade >= attempts`, but a stall-killed job fails with `attemptsMade` still ~1 → handler logs "will retry" and fires no exhaustion alert; the worst failures are silent | S2 | M | `jobs/failureHandler.ts:11-19` | queueing |
| C-89 (R4) | Swallowed throws → green jobs at 3 sites: draft-order block (DP-po-18), pre-reply umbrella catch (DP-GPR-28), post-ACK webhook enqueue | S1 | H | `jobs/processAIReply.ts:3831-3837` | DP-po-18, DP-GPR-28 |
| C-90 (R5) | **NEW** — Channel send wraps everything (incl. rate-limit error) into `{success:false}` (never throws), and the limiter busy-polls up to 60s inside the conv lock + worker slot; two stalls saturate the prod pool (concurrency 2); eval-usecase enqueued even when send failed | S2 | H | `services/outboundChannelRateLimiter.ts:70-98` | queueing §6.2 |
| C-91 (R6) | Rate-limit pause tx is fail-open: on DB blip the customer gets silence with no `ai_paused` and no alert, then silent auto-resume when the 3600s counter TTLs | S2 | H | `jobs/processAIReply.ts:1237-1294` | DP-iq-22 |
| C-92 (R7) | **NEW** — Fine-tuning self-poll re-adds with `attempts:1`; a single transient poll error permanently ends the chain (silent stall), or loops forever if terminal never reached | S3 | M | `jobs/checkFinetuningStatus.ts:34-39` | queueing §4.6 |
| C-93 (R8) | OpenAI degradation flips guards inconsistently: the gap assessor is the only fail-closed guard (escalates every product question) while neighbors fail open / disable the hallucination suite | S2 | H | `services/productInformationGapService.ts:105` | DP-gg-14/31 |
| C-94 (R9) | Webhook fixed 5s backoff + timestamp-skew fail-open (`Date.now()` when absent) + global dedup interact to lose/misroute events; inconsistent across channels, no DLQ | S2 | M | `controllers/webhookController.ts:303` | DP-iq-01 |

### Streaming

The backend performs zero streaming — every OpenAI call is blocking, so the customer sees nothing until the full reply is generated, compounding the serialized classifier fan-out into one long wait. There is no per-call abort on the reply, `finish_reason` is never checked (silent truncation at 768 tokens), and guards cannot overlap generation. This is a wholly new domain, uncovered by prior phases.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-95 (S1) | **NEW** — No streaming on the customer reply path; `new_message` fires only after the finished reply is persisted → full-latency blocking generation atop the serialized fan-out | S2 | H | `services/aiService.ts:4118` | seed classifiers |
| C-96 (S2) | **NEW** — Reply call passes no `AbortSignal`/per-request timeout; inherits SDK 60s×(1+3) ≈ 240s while holding the tenant slot + conv lock, with no partial-answer surface | S2 | H | `services/openaiClient.ts:20-29` | seed |
| C-97 (S3) | **NEW** — Completion checks only for empty content, never `finish_reason`; a long reply truncates mid-sentence at `max_tokens:768`, dropping the fixed phrases order-confirmation guards expect; no `length` retry path | S2 | M | `services/aiService.ts:4123-4129` | — |
| C-98 (S4) | **NEW** — Post-reply guards can't begin until the full non-streamed string exists; total latency is generation-in-full THEN each guard's own serial LLM call | S3 | M | `jobs/processAIReply.ts:2721` | seed |

### Model Config

Three severe drift/override axes: the vision path silently discards a tenant's fine-tuned `custom_model_id` on any image turn, `QUALITY_THRESHOLD` drifts 0.1 (code) vs 0.6 (.env.example) — gating pause-at-checkout — and the embedding model/dimension landmine. Plus un-seeded stochasticity whose code comments overstate a determinism guarantee that does not exist.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-99 (M1) | `custom_model_id` discarded when `hasImages` → same customer/product resolves on two different models (text vs photo), an invisible Issue-1 divergence generator | S2 | H | `services/aiService.ts:4106-4108` | DP-gg-02, DP-pc-01/02/08 |
| C-100 (M2) | `QUALITY_THRESHOLD` 0.1 (code/docs) vs 0.6 (.env.example); eval scores order confirmations ~0.200 → under 0.6 that alerts + pauses at checkout (no auto-resume) | S1 | H | `services/aiQualityService.ts:28` | S-55, DP-gg-24 |
| C-101 (M3) | Embedding default `3-large` (3072) vs `.env` `3-small` (1536), no `dimensions` param → retrieval breaks or writes fail on the wrong provenance | S1 | H | `services/openaiClient.ts:35-36` | DP-retrieval-22 |
| C-102 (M4) | **NEW** — Chat model default `gpt-4o` (code) vs `gpt-4o-mini` (.env.example) drives both the reply and ~28 classifiers → quality/accuracy differ purely by config provenance | S2 | M | `services/openaiClient.ts:31` | S-55 |
| C-103 (M5) | Only 2 of ~30 classifier sites honor a dedicated role model env var; the fan-out can't be routed to a cheaper/deterministic model | S3 | H | `services/aiService.ts` | seed classifiers |
| C-104 (M6) | **NEW** — No `seed`/`top_p` anywhere; reply at 0.3 is overtly stochastic, yet code comments assert the prompt resolves "the SAME way every time" — a first-order Issue-1 driver (EV-025) | S2 | H | `services/aiService.ts:115-126` | EV-025 |
| C-105 (M7) | Admin test-AI sandbox diverges from prod model config (temp 0.7, 1024 tokens, no guards) — masks the divergence/escalation issues under audit | S2 | M | `controllers/adminAiController.ts:340-349` | seed |
| C-106 (M8) | **NEW** — Three model-resolution chains (imported const vs re-read `process.env` vs literal `'gpt-4o'`) can diverge on partial env and silently mask a typo'd var | S3 | M | `services/aiService.ts:4108` | CLAUDE.md §11 |

### Observability

The single biggest observability defect: the assembled system prompt — the actual LLM input — is never logged or persisted, so a divergence can't be reconstructed post-hoc. Token/cost/latency is never captured on a usage-billed product, `traceId` collapses at the service boundary (2/101 lines), and AI-path errors never reach Sentry. Customer PII is logged in cleartext.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-107 (OBS-1) | The assembled system prompt is never logged or persisted; the exact input behind any reply is discarded the moment the call returns — Issue 1/2 become un-triageable | S1 | H | `services/aiService.ts:3919-4124` | EV-011/013/015, EV-025 |
| C-108 (OBS-2) | **NEW** — `completion.usage` discarded on every call; a usage-billed product (5% + tiered fees) has zero per-conversation LLM cost visibility across an 18–25-call fan-out | S2 | H | `services/aiService.ts:4118-4126` | CLAUDE.md §8 |
| C-109 (OBS-3) | `traceId` attached to only 2/101 log lines in the job; `aiService.ts` never receives/logs it → a message's journey can't be stitched across concurrent workers | S2 | H | `jobs/processAIReply.ts:1150` | S-05 |
| C-110 (OBS-4) | Sentry wired as Express error handler only; 0 `captureException` in `jobs/`; the pervasive catch-and-continue lines are invisible to error monitoring | S1 | H | `instrument.ts:27-37` | DP-GPR-28, DP-gg-14 |
| C-111 (OBS-5) | The one retrieval log line has `tenantId` but no conversation/message/trace id, so the correct↔escalated variable can't be joined to the reply it caused; also logs raw query | S2 | H | `services/aiService.ts:742-758` | DP-retrieval-08 |
| C-112 (OBS-6) | No metrics/counters for AI decisions; escalation/guard-strip/`semanticSkipped`/[NO_REPLY] rates are free-text only, undetectable as trends | S2 | M | `jobs/processAIReply.ts:1299-1359` | Q7, S-67 |
| C-113 (OBS-7) | **NEW** — Raw customer text (names/phones/addresses/health context) logged in cleartext to stdout at ≥4 sites with no redaction layer → GDPR/retention exposure | S2 | H | `services/aiService.ts:744` | SEC-5 |

### Security

Two S1 isolation defects: the inbound dedup and the channel→tenant resolution queries are both globally scoped with no tenant predicate (and no `ORDER BY`), so a re-onboarded page/number can route a webhook — and its AI reply, catalog, persona, and commission — to an arbitrary tenant. The history loader trusts upstream resolution entirely, and customer text is interpolated unsanitized into instruction-framed prompts. The admin auth boundary was verified correct.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-114 (SEC-1) | `findMessageIdByExternalMessageId` has no tenant/channel scope → cross-tenant collision silently drops a paying tenant's inbound and leaks cross-tenant existence | S1 | H | `db/models/message.ts:290-298` | DP-iq-06, S-07 |
| C-115 (SEC-2) | `findChannelByTypeAndExternalId` (sole webhook tenant resolver) has no tenant scope and no `ORDER BY`; a dual-connected external_id routes inbound to an arbitrary tenant — highest-severity isolation defect | S1 | H | `db/models/channel.ts:119-128` | DP-iq-07, S-08 |
| C-116 (SEC-3) | AI history loader is conversation-scoped only; the 40-message window is injected into the prompt with zero tenant re-verification (S1 if reached via SEC-2) | S2 | H | `db/models/message.ts:304-321` | SEC-2, S-20 |
| C-117 (SEC-4) | Customer content wrapped in directive strings (`Customer replied to: '…'`, edit-hint block) with no escaping/injection guard; a crafted message can attempt to steer pricing/discount/order confirmation on an autonomous commissionable agent | S2 | M-H | `services/aiService.ts:3019-3047` | S-39, DP-GPR-27 |
| C-118 (SEC-5) | PII in logs (= OBS-7) plus alert rows carrying customer content with no redaction; pre-06-23 alert details null/unclassifiable, 06-27 mojibake regression | S2 | H | `services/aiService.ts:744-4280` | OBS-7, S-29 |
| C-119 (SEC-6) | Channel-token AES-256-GCM is sound but ciphertext has no key id/version → rotation is a big-bang re-encrypt; decryption failure degrades to silent non-delivery (send never throws) | S3 | M | `services/cryptoService.ts:39-61` | S-63/68 |
| C-120 (SEC-7) | *(Positive)* Admin auth boundary verified correct: rejects a business token with 403, distinct 503 when admin JWT unconfigured; no escalation gap | S3 | H | `middleware/authenticateAdmin.ts:17-48` | CLAUDE.md §5 |

### Performance

The latency profile is dominated by an unconditional 8s debounce floor plus a deep, serialized, largely-uncached LLM fan-out (18–25 typical, ~70 worst-case) whose worst case can exceed the 300s conversation-lock TTL. The single largest multiplicative term is a per-assistant-message LLM classifier invoked twice per job (~40 calls), and duplicate classifier calls run with no batching or per-conversation cache.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-121 (P1) | Deep serialized LLM fan-out is the dominant latency term; one slow classifier stalls the whole reply, and each call is another fail-open/closed surface | S1 | H | `jobs/processAIReply.ts:1373-3529` | DP-GPR-04, orchestration §5 |
| C-122 (P2) | Conv lock (300s) can be shorter than a job's ~25–70-call worst case; auto-expiry mid-run allows a duplicate job to process concurrently (send idempotent, LLM/order path not) | S2 | M | `jobs/processAIReply.ts:1197-1213` | DP-GPR-04, S-15 |
| C-123 (P3) | Unconditional 8s debounce is a fixed floor on every first reply; realistic first-response ≈ 8s + 10–15s LLM ≈ 18–23s | S2 | H | `jobs/processInboundMessage.ts:886-907` | DP-iq-16 |
| C-124 (P4) | 5s embedding race is non-aborting: caps latency but not cost/connection hold; on category path the embedding is generated then discarded | S2 | H | `services/aiService.ts:650-663` | DP-retrieval-01/02/03/23 |
| C-125 (P5) | Adaptive `ef_search` double-pass (2nd at 500 over the global index) fires on nearly every query for small/new tenants; "cheap bounded cost" comment understates frequency | S2 | H | `db/models/product.ts:804-814` | DP-retrieval-07 |
| C-126 (P6) | **NEW** — `hasAssistantAskedOrderClosingInConversation` calls an uncached per-assistant-message LLM classifier, invoked twice per job over a re-fetched 40-message window (~40 calls) — the largest multiplicative term, growing with depth (worsens Q4) | S1 | H | `jobs/processAIReply.ts:2597` | orchestration §5, S-52 |
| C-127 (P7) | **NEW** — `classifyNewOrderSignal` + `detectOrderAffirmationIntent` each run twice per job on overlapping context; no cross-call batching or per-conversation classifier cache → token/latency scale super-linearly | S2 | H | `jobs/processAIReply.ts:1593-3529` | orchestration §5, DP-GPR-22 |
| C-128 (P8) | **NEW** — Per reply: double 40-message history fetch + 13 explicit `pool.connect()` transaction sites + multi-source retrieval SQL against a `PG_POOL_MAX=10` pool | S2 | M | `jobs/processAIReply.ts:1338-3575` | S-20, DP-po-13 |
| C-129 (P9) | Query-embedding cache per-process, FIFO (mislabeled LRU), size 256, no TTL, unshared; low hit rate, reset every deploy | S3 | H | `services/aiService.ts:614-644` | DP-retrieval-03 |

### Scalability

Posture is single-instance vertical-only: all five workers run in-process with the HTTP API on one 1-vCPU/2-GB droplet, capped by a shared `PG_POOL_MAX=10` (≈8-instance DB ceiling) and a `noeviction` 192-MB Redis that co-locates cache and queue with unbounded failed-job sets. The global HNSW index degrades as the platform grows, the fairness cap is simultaneously inert and hazardous, and the debounce scan is O(queue-depth) per inbound.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-130 (SC1) | All 5 workers + Express + Socket.IO in one 1-vCPU process; no separate worker deploy, no replicas → throughput ceiling ~2 concurrent AI replies system-wide | S1 | H | `server.ts:5-18` | deployment §A, seed |
| C-131 (SC2) | **NEW** — `PG_POOL_MAX=10` shared by API + all workers; each reply checks out many connections serially → saturation under prod concurrency; Postgres `max_connections=80` ⇒ ~8-instance horizontal ceiling; not tuned per role | S2 | H | `db/pool.ts:53-58` | P5, P8 |
| C-132 (SC3) | Global HNSW index + tenant post-filter: a small tenant's matches get crowded out as total rows grow; the only mitigation is a fixed 500-candidate ceiling → recall monotonically degrades with platform success | S2 | H | `db/models/product.ts:721-729` | DP-retrieval-08 |
| C-133 (SC4) | **NEW** — Fairness cap (8) exceeds prod ai concurrency (2), so the per-tenant cap never engages (a noisy tenant with 2 jobs already starves everyone); when it *does* engage it busy-loops re-adding fresh jobs every 3s | S2 | M | `jobs/processAIReply.ts:1093-1096` | DP-iq-19/20 |
| C-134 (SC5) | Debounce deserializes every tenant's pending ai jobs into memory on every inbound then removes at most one — an O(queue-depth) scan that grows precisely as the system saturates | S2 | H | `jobs/processInboundMessage.ts:886-892` | DP-iq-17 |
| C-135 (SC6) | **NEW** — `noeviction` 192-MB Redis holds locks, counters, caches AND all queue state; `evaluateConversationUseCase` jobs use `removeOnFail:false` → unbounded growth; at 192 MB every `SET`/`INCR`/`add` errors, halting the whole pipeline with no eviction valve | S2 | H | `docker-compose.prod.yml:50-53` | deployment §A.2 |
| C-136 (SC7) | **NEW** — Single FIFO ai queue × concurrency 2 × 8s delay, no backpressure/shedding/priority; a burst grows depth unbounded before any alert, retry storms compound it | S2 | M | `jobs/queues/aiQueue.ts:10-14` | queueing §2/§8 |
| C-137 (SC8) | **NEW** — `default` queue concurrency-1 multiplexes per-minute + per-2-minute cron reconciles with priority-1 live embeds → a slow reconcile blocks the embed a new product needs, triggering more zero-hit self-heals | S3 | M | `docker-compose.prod.yml:68-70` | queueing §3/§7 |
| C-138 (SC9) | Socket.IO Redis adapter wired for multi-instance but only one instance exists → every emit pays a pub/sub round-trip no second instance consumes | S3 | H | `sockets/index.ts:27-39` | deployment §A.1 |

### Maintainability

`processAIReply()` is a ~2,700-line god-function (51 try/catch blocks) where every divergence-path defect lives as inline logic and the billing-critical guard *ordering* is expressed purely as statement order — invisible to any type system or test. AI behavior is versioned as 19 prompt-mutating SQL migrations with force-sync overwrites and no revert path, and coarse umbrella/swallow catches make failure indistinguishable from success.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-139 (M1) | `processAIReply()` is a single ~2,700-line frame sharing hundreds of mutable locals; 51 try/catch, many nested 3–4 deep; guard ordering is untyped/untested positional code | S1 | H | `jobs/processAIReply.ts:1148` | DP-GPR-27/28, DP-po-18 |
| C-140 (M2) | The billing-critical guard pipeline has zero automated coverage; 548 green tests exercise only extracted leaf helpers → false confidence | S1 | H | `services/__tests__/` | EV-025, DP-gg-14/31 |
| C-141 (M3) | 35 `chat.completions.create` sites across 10 files, mostly serialized; consolidation blocked because wiring is inlined in the god-function | S2 | H | `services/aiService.ts` | seed classifiers, Phase6 |
| C-142 (M4) | 19 prompt-mutating migrations (several unconditional force-sync overwriting tenant edits); no single source of truth, no A/B, forward-only, no revert | S2 | H | `db/migrations/052_force_sync_locked_prompt_blocks.sql` | DP-pc-01/02/08, Phase7 |
| C-143 (M5) | Umbrella try/catch (1379–1948) + swallow catch (3831–3837) make a single OpenAI hiccup change business outcome with only a log line; catch scopes are load-bearing, so refactoring is hazardous | S1 | H | `jobs/processAIReply.ts:1379-1948` | DP-GPR-28, DP-po-18 |
| C-144 (M6) | Cross-tier duplicated constants drift silently (frontend hardcodes `HUMAN_HOLD_MS`); backend timing not exported to a shared contract | S3 | M | `frontend/src/pages/inbox/InboxPage.tsx:52-54` | mapper D.2, FE-6 |

### Testing

The 548 unit tests (green locally) are never run by CI, cover only deterministic leaf helpers, and structurally cannot catch the stochastic, side-effecting, billing-affecting slice that produces every audited incident. There is no AI eval/regression harness and no frontend test runner at all — coverage is exactly inverted: the failing paths are the untested paths.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-145 (T1) | **NEW** — CI (`ci.yml`) runs typecheck/build/smoke/lint but never `npm test`; the token `test` appears only as `NODE_ENV`; any regression in tested helpers merges unblocked | S1 | H | `.github/workflows/ci.yml:72` | mapper A.3, CLAUDE.md §4 |
| C-146 (T3) | **NEW** — No golden-transcript/eval-model harness; the one CI runtime check boots with a placeholder key and only polls `/api/health` — no message traverses `processAIReply`; frontend has no test runner | S1 | H | `.github/workflows/ci.yml:80` | EV-025, Q4/Q7 |
| C-147 (T4) | **NEW** — Cross-referencing the DP register: every verified failure locus (`processAIReply`, queue dedup, retrieval race, billing snapshot) has 0 tests; the tested set is exactly the deterministic, side-effect-free slice | S1 | H | `services/__tests__/` | DP register, WF-B |
| C-148 (T8) | **NEW** — Frontend `package.json` exposes only dev/build/lint/preview; optimistic mutations, socket cache patching, client-derived pause state, and normalizers are entirely unverified | S3 | M | `frontend/package.json` | mapper D.2/D.5 |

### Deployment

Staging deploy is not gated on CI — both workflows key on push-to-main and run concurrently, so a broken build can be live on staging while CI is still red. Migrations are forward-only, run twice per deploy with no advisory lock and no rollback, the numbering contract is already broken (duplicate 062), and a replace-in-place deploy whose 25s drain exceeds Docker's 10s grace SIGKILLs in-flight AI jobs that then retry non-idempotently.

| ID | Finding | Sev | Conf | file:line | Links |
|----|---------|-----|------|-----------|-------|
| C-149 (T2) | **NEW** — `deploy.yml` triggers `deploy-staging` on push-to-main with no `needs:`/`workflow_run:` on CI; a commit that fails typecheck/build/lint still fires the staging deploy hooks | S1 | H | `.github/workflows/deploy.yml:3-24` | mapper A.4, T1 |
| C-150 (T5) | **NEW** — Two files share ordinal 062; the runner sorts by full filename so both apply and order is `c<m` alphabetic, not intent; renaming to fix re-executes force-sync UPDATEs | S2 | H | `db/migrate.ts:19-22` | DP-12/14/15, mapper G |
| C-151 (T6) | **NEW** — Migrations run at deploy AND every container boot, no `pg_advisory_lock` (TOCTOU), no down migrations, no automated rollback, not transactional across files → a mid-sequence throw leaves schema half-migrated | S1 | H | `db/migrate.ts` | mapper A.5/B/G |
| C-152 (T7) | **NEW** — Single-instance replace-in-place; `SHUTDOWN_TIMEOUT_MS=25000` but no `stop_grace_period` so Docker's 10s window truncates the drain → in-flight `ai.reply` SIGKILLed, stalled, re-executed non-idempotently (duplicate spend/alerts, WhatsApp re-generated reply) — a deploy-injected Issue-1 divergence | S2 | H | `server.ts:41` | DP-po-09/10/11 |

---

## New findings not previously captured

These 53 `isNew=true` findings are the Phase 9 contribution that feeds Phase 11. (Prior-phase findings appear above as one-line links and are excluded here.)

| ID | Domain | Title | Sev | Conf | file:line |
|----|--------|-------|-----|------|-----------|
| C-01 | Architecture | AI reply pipeline lives in a 3,847-line job, not a service | S2 | H | `jobs/processAIReply.ts:1148` |
| C-02 | Architecture | `aiService.ts` 4,296-line god-service mixing retrieval/prompt/classifiers/gen/filters | S2 | H | `services/aiService.ts:614-4132` |
| C-03 | Architecture | Three divergent homes for assemble-prompt/send-reply (job/controller/admin inline) | S2 | H | `controllers/adminAiController.ts:320-349` |
| C-06 | Architecture | Controller queue access via `as unknown as` cast + duplicated jobId literal | S3 | M | `controllers/conversationController.ts:218-227` |
| C-07 | Backend | `validate` never rewrites `req.query`/`params` (Express 5) — coerced values only on `req.validated` | S2 | H | `middleware/validate.ts:38-44` |
| C-08 | Backend | AI on/off toggle has no validation, blind flip races to opposite states | S2 | M | `controllers/chatbotControlController.ts:21-41` |
| C-09 | Backend | Dead 403-stub endpoints registered without validators | S3 | H | `routes/aiConfig.ts:11-12` |
| C-12 | Backend | Admin AI-test endpoint exercises a different system than production | S2 | H | `controllers/adminAiController.ts:295-361` |
| C-13 | Backend | `sendError` leaks raw non-Error payload in every environment | S2 | M | `utils/response.ts:28-36` |
| C-14 | Frontend | Two contradictory AI-paused indicators in one footer | S2 | H | `pages/inbox/InboxPage.tsx:765-774` |
| C-15 | Frontend | Paused-conversations list mislabeled manual-only; query returns all `ai_paused` | S2 | H | `pages/chatbotControl/ChatbotControlPage.tsx:225-227` |
| C-21 | Frontend | Feedback form invalidates `['ai-config']` though feedback never mutates it | S3 | M | `components/inbox/AiMessageFeedbackForm.tsx:44` |
| C-23 | AI Pipeline | No prompt versioning/provenance — divergence un-forensic | S2 | H | `services/aiService.ts:3919-4092` |
| C-39 | RAG | Adaptive `ef_search` recovers under-fill but never wrong-fill | S2 | M | `db/models/product.ts:811-812` |
| C-45 | Data Access | Hot history query has no covering index; backward-scan bad-plan risk | S2 | M | `db/models/message.ts:309-318` |
| C-46 | Data Access | AI-context history fetch has no tenant predicate | S3 | M | `db/models/message.ts:304-319` |
| C-48 | Data Access | Duplicate 062 migration prefix; numbering no longer encodes order | S3 | H | `db/migrations/062_*.sql` |
| C-59 | Cache | In-process `availabilityCache` unbounded (no cap, no sweep) | S3 | M | `services/productAttributeAvailabilityService.ts:44` |
| C-63 | Tooling | Confidence scale-guessing (`>1?/100`) collapses overconfident outputs 100× | S2 | M | `services/intentDetectionService.ts:52-54` |
| C-67 | Tooling | Product-import service bypasses OpenAI singleton; fail-open `[]` catalog loss | S2 | H | `services/AIProductProcessingService.ts:34-35` |
| C-69 | Tooling | Admin sandbox misrepresents production classifier behavior | S3 | M | `controllers/adminAiController.ts:341-349` |
| C-74 | Intent | Intent prompt internally contradictory (0.75 vs 0.85), range-unspecified | S2 | M | `services/intentDetectionService.ts:119-133` |
| C-78 | Async | Debounce `remove()` can lose the AI job entirely → artifact-free silence | S1 | H | `jobs/processInboundMessage.ts:886-907` |
| C-80 | Async | Fairness slot TTL expires mid-job → counter driven negative by `finally` DECR | S2 | M | `jobs/processAIReply.ts:1153-1190` |
| C-84 | Async | eval-usecase jobId dedup drops close-time eval → 4h billing latency | S3 | H | `jobs/processAIReply.ts:3459-3470` |
| C-88 | Reliability | `failureHandler` misclassifies stall-killed jobs as retryable → no alert | S2 | M | `jobs/failureHandler.ts:11-19` |
| C-90 | Reliability | Non-throwing send + 60s busy-wait limiter pins worker pool; eval enqueued on failed send | S2 | H | `services/outboundChannelRateLimiter.ts:70-98` |
| C-92 | Reliability | Fine-tuning self-poll `attempts:1` makes a transient error terminal | S3 | M | `jobs/checkFinetuningStatus.ts:34-39` |
| C-95 | Streaming | No streaming on the customer reply path — full-latency blocking | S2 | H | `services/aiService.ts:4118` |
| C-96 | Streaming | Reply has no per-call abort; inherits SDK ~240s while holding lock/slot | S2 | H | `services/openaiClient.ts:20-29` |
| C-97 | Streaming | Completion ignores `finish_reason` — silent truncation at 768 tokens | S2 | M | `services/aiService.ts:4123-4129` |
| C-98 | Streaming | Guards cannot overlap generation — strictly sequential (batch output) | S3 | M | `jobs/processAIReply.ts:2721` |
| C-102 | Model Config | Chat model default `gpt-4o` (code) vs `gpt-4o-mini` (.env.example) | S2 | M | `services/openaiClient.ts:31` |
| C-104 | Model Config | No `seed`/`top_p` anywhere; comments overstate determinism | S2 | H | `services/aiService.ts:115-126` |
| C-106 | Model Config | Three model-resolution chains can diverge on partial env, mask typos | S3 | M | `services/aiService.ts:4108` |
| C-108 | Observability | Token usage/cost/latency never captured on any AI call | S2 | H | `services/aiService.ts:4118-4126` |
| C-113 | Observability | Customer PII logged in cleartext to stdout, no redaction | S2 | H | `services/aiService.ts:744` |
| C-126 | Performance | Per-assistant-message LLM classifier, twice per job (~40 calls) | S1 | H | `jobs/processAIReply.ts:2597` |
| C-127 | Performance | Duplicate classifier calls; no batching/per-conversation cache | S2 | H | `jobs/processAIReply.ts:1593-3529` |
| C-128 | Performance | Double 40-message fetch + 13 transactions per reply vs pool of 10 | S2 | M | `jobs/processAIReply.ts:1338-3575` |
| C-131 | Scalability | `PG_POOL_MAX=10` shared; ~8-instance ceiling + hot-path bottleneck | S2 | H | `db/pool.ts:53-58` |
| C-133 | Scalability | Fairness cap (8) inert vs prod concurrency (2); busy-loop at scale | S2 | M | `jobs/processAIReply.ts:1093-1096` |
| C-135 | Scalability | `noeviction` Redis co-locates cache + queue + unbounded failed sets | S2 | H | `docker-compose.prod.yml:50-53` |
| C-136 | Scalability | Single FIFO ai queue, no backpressure/shedding/priority | S2 | M | `jobs/queues/aiQueue.ts:10-14` |
| C-137 | Scalability | `default` queue concurrency-1 cron reconciles contend with live embeds | S3 | M | `docker-compose.prod.yml:68-70` |
| C-145 | Testing | CI never runs the test suite | S1 | H | `.github/workflows/ci.yml:72` |
| C-146 | Testing | No AI eval/regression harness; smoke exercises zero AI code | S1 | H | `.github/workflows/ci.yml:80` |
| C-147 | Testing | Coverage inverted: failing paths are the untested paths | S1 | H | `services/__tests__/` |
| C-148 | Testing | Frontend has no test infrastructure | S3 | M | `frontend/package.json` |
| C-149 | Deployment | Staging deploy not gated on CI (concurrent workflows) | S1 | H | `.github/workflows/deploy.yml:3-24` |
| C-150 | Deployment | Duplicate migration 062 breaks numbering contract | S2 | H | `db/migrate.ts:19-22` |
| C-151 | Deployment | Forward-only migrations, run twice, no lock/rollback → half-migrate | S1 | H | `db/migrate.ts` |
| C-152 | Deployment | Replace-in-place deploy SIGKILLs in-flight jobs → non-idempotent retries | S2 | H | `server.ts:41` |

---

## Severity rollup

**By severity (all 152 findings):** S0 = **0** · S1 = **30** · S2 = **96** · S3 = **26**. NEW = **53**.

| Domain | Findings | S0 | S1 | S2 | S3 | NEW |
|--------|:--:|:--:|:--:|:--:|:--:|:--:|
| Architecture | 6 | 0 | 0 | 5 | 1 | 4 |
| Backend | 7 | 0 | 0 | 5 | 2 | 5 |
| Frontend | 8 | 0 | 0 | 5 | 3 | 3 |
| AI Pipeline | 9 | 0 | 2 | 6 | 1 | 1 |
| Conversation | 6 | 0 | 0 | 5 | 1 | 0 |
| RAG | 8 | 0 | 2 | 5 | 1 | 1 |
| Data Access | 8 | 0 | 1 | 3 | 4 | 3 |
| Cache | 9 | 0 | 2 | 3 | 4 | 1 |
| Tooling | 8 | 0 | 2 | 5 | 1 | 3 |
| Intent | 8 | 0 | 2 | 5 | 1 | 1 |
| Async | 8 | 0 | 1 | 6 | 1 | 3 |
| Reliability | 9 | 0 | 1 | 7 | 1 | 3 |
| Streaming | 4 | 0 | 0 | 3 | 1 | 4 |
| Model Config | 8 | 0 | 2 | 4 | 2 | 3 |
| Observability | 7 | 0 | 2 | 5 | 0 | 2 |
| Security | 7 | 0 | 2 | 3 | 2 | 0 |
| Performance | 9 | 0 | 2 | 6 | 1 | 3 |
| Scalability | 9 | 0 | 1 | 6 | 2 | 5 |
| Maintainability | 6 | 0 | 3 | 2 | 1 | 0 |
| Testing | 4 | 0 | 3 | 0 | 1 | 4 |
| Deployment | 4 | 0 | 2 | 2 | 0 | 4 |
| **Total** | **152** | **0** | **30** | **96** | **26** | **53** |

**S1 concentration (30 findings):** Maintainability and Testing carry 3 S1 each (the god-function + the total absence of automated coverage on the failing paths). Two S1 each land in AI Pipeline, RAG, Cache, Tooling, Intent, Model Config, Observability, Security, Performance, and Deployment — the S1 mass clusters on the AI reply path and its (missing) safety net, consistent with Issue 1 and Issue 2 being emergent properties of the whole pipeline rather than a single defect.
