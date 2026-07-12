# Phase 15 — Observability Audit

> **Evidence base:** Grounded in source code (file:line), the dev/staging database, live-replay experiments (Phase 10), and the confirmed root causes of Phase 11. Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md.

---

## 15.0 Scope, method, and headline verdict

This phase asks one operational question: **if a paying tenant reported "your AI told my customer we don't sell a product we clearly sell" (Issue 2) or "the same question got two different answers" (Issue 1), could Hillside's on-call engineer reconstruct what happened from the telemetry the system actually emits?** The answer is examined against ten mandated observability categories, then stress-tested against the single best-documented real incident in the corpus — the `fcd0af7e` false-hallucination escalation (Phase 4 Trace 1; EV-011/013/015).

Method: read every logging/telemetry emission site in `backend/src` (277 `console.*` calls across 40 files; the sole Sentry init at `instrument.ts:23-37`; the `analytics_events` writer at `analyticsService.ts:18-32`; BullMQ retention config; the one `[retrieval]` structured line), cross-checked against what the dev DB actually persisted (`messages`, `ai_alerts`, `analytics_events` rows) and against the confirmed root causes RC-01…RC-26. Observations only — remediation is Phase 16.

**Headline:** Observability is **not present** on the AI reply path in any form that would let an incident be reconstructed. Of the ten mandated categories, **five are absent** (prompt, tool/classifier decisions, conversation-state transitions, cache behaviour, performance/token telemetry) and **five are partial** (request identity, retrieval, decision points, queue ops, errors); **none is fully present**. The through-line is that the actual LLM input — the assembled 26–33K-char system prompt (`aiService.ts:3919-4124`) — and the model/params/token-usage of every one of the ~18–25 calls per message (`C-121`) are discarded the instant each call returns. Every durable forensic artifact that exists (`messages.product_ids`, `flagged`, `quality_score`, and post-`2026-06-23` `ai_alerts.details`) is a *side-effect* of business logic, not a telemetry design. This is the mechanical reason Issue 1 and Issue 2 have been "un-triageable in production" (`C-107`, OBS-1, S1): the divergence is real (RC-01, RC-02, RC-03; live-replay 8/8, EV-025) but leaves almost no trace.

---

## 15.1 Coverage by mandated category

Each category carries a verdict — **PRESENT** / **PARTIAL** / **ABSENT** — with the specific emission sites (or their absence) as evidence.

### (1) Request identity — **PARTIAL**

A single correlation id, `traceId`, is minted per inbound webhook (`webhookController.ts:238` — `crypto.randomUUID()`; `viberWebhookController.ts` similarly) and threaded onto the BullMQ job payload (`jobTypes.ts:117`, `InboundWebhookJobData.traceId`). It reaches the AI job (`processAIReply.ts:1149-1150` logs `[ai.reply] processAIReply start {traceId, tenantId, conversationId}`) and one language line (`:1375`). That is the full extent of it.

What's missing:
- **No HTTP request-id.** The REST/API surface (all `/api/*` business + admin routes) has no request-id middleware — `traceId` is a *webhook-only* construct. A tenant-facing action (toggle AI, resolve alert, edit config) cannot be correlated to its downstream effects.
- **The correlation collapses at the service boundary.** `aiService.ts` never receives or logs `traceId` (0 references — confirmed: `traceId` appears in only 5 files, none of them `aiService.ts`). The `[retrieval]` line, every classifier, and the main completion emit **no** correlation id, so a message's journey cannot be stitched across the 4,296-line service or across concurrent workers (`C-109`, OBS-3: "2/101 lines in the job carry traceId; aiService 0 refs"). Under prod concurrency (2 ai workers) interleaved stdout is unattributable.
- No per-message id on the trace: `traceId` is per-*webhook-delivery*, and a burst-merge (RC-05) collapses several inbound rows under whichever delivery won the debounce, so even the id that exists does not map 1:1 to a customer message.

### (2) Prompt — **ABSENT** *(the key gap)*

**The assembled system prompt — the actual bytes sent to the model — is never logged, never persisted, never hashed.** It is built at `aiService.ts:3919-4124` from mutable `tenant_prompt_blocks` + `ai_configs` + ~13 conditional runtime appends, used as the `messages[0]` argument to `openai.chat.completions.create` (`:4118-4124`), and discarded when the function returns `reply`. There is no prompt column on `messages`, no `prompt_hash`, and the `ai_config_versions` history (if any) is unlinked to the reply it produced (`C-107` OBS-1 **S1**; `C-23` AP-2: "the exact input behind any reply is unreconstructable").

Compounding gaps:
- **Model and params are not logged per call.** `model`, `temperature`, `max_tokens` are passed as call arguments (main reply `:4106-4124`; ~30 classifier sites e.g. `:1009/1029/1030`, `:1128/1141/1142`) but never emitted. So even *which model answered* is unknown at read time — and this is not academic: `custom_model_id` is silently dropped on image turns (`C-99`, RC-17), and the delete-only 900s `ai_config` cache (RC-17, `C-53`) means two workers can call **different models** for the same tenant within one conversation, with nothing recording which.
- The orphan `offers_promotions` block that injects a phantom "Active offers" directive into 6/6 tenant prompts (RC-26, `C-25`) is invisible per-reply — you cannot tell from any log whether a given reply carried it.
- Because the prompt is unversioned and unstamped (`C-23`), the standing question "did this reply run with the business-rules footer or without it?" (RC-25: footer reaches 1/6 tenants) is unanswerable for any historical reply.

### (3) Retrieval — **PARTIAL**

Exactly **one** structured line exists in the whole pipeline: `console.info('[retrieval]', {...})` at `aiService.ts:742-752`, plus a companion `console.warn('[retrieval] Semantic path skipped…')` at `:755-758`. It captures `tenantId`, a 120-char query prefix, `categoryIntent`, `semanticSkipped`, per-source counts, `fused` count, `topIds`/`topNames` (top-5), and `elapsedMs`.

What it does **not** capture — and why each omission is load-bearing:
- **No similarity/distance scores.** It logs *which* products were fused but not *how close* they were. So the core Issue-2 mechanism — "the correct catalog product missed the 0.65 JS post-filter threshold by X" (RC-02, `C-40`) — is invisible. You cannot tell a near-miss from a total miss.
- **No conversation / message / trace id** (`C-111`, OBS-5). The retrieval result — the single most important variable in the correct-vs-escalated outcome — cannot be joined to the reply it grounded, nor to concurrent workers' lines.
- **Ephemeral stdout only.** `semanticSkipped` (the RC-04 timing coin-flip: did the 5s non-aborting embedding race resolve in time?) lives only in process stdout with no aggregator wired (§15.2). Whether semantic retrieval ran *at all* for a given reply is therefore unrecoverable after the container recycles.
- Logs raw customer query text to stdout (`:744`) — a PII exposure (`C-113`, OBS-7) rather than an observability asset.

The *durable* retrieval artifact is a business side-effect, not this log: `messages.product_ids` persists the fused UUID set (e.g. 10 IDs on the `fcd0af7e` turn-6 row). That is the only retrieval telemetry that survives — and it carries no scores and no indication of whether the semantic arm contributed.

### (4) Tool / classifier execution — **ABSENT**

The pipeline fans out to 18–25 (worst-case ~70) LLM classifier calls per message (`C-121`, `C-126`, RC-01/07/08/22). **None of their decisions is logged.** The only classifier emission in the codebase is a single parse-failure warning: `intentDetectionService.ts:46` `console.warn('[intentDetection] Failed to parse intent JSON response', {raw})`. There is no record of:
- the purchase-intent score vs the 0.75/0.85 thresholds (RC-08, `C-71/C-74`) that decides order-creation;
- the confidence-boost events (4 detectors overwrite 0→0.9/0.85; RC-07, `C-70`) that force-clear escalation gates;
- which of cancel/refund/post-purchase/order-info special paths fired or was swallowed by the umbrella catch (RC-19, `C-65`);
- the product-info-gap assessor's verdict — the RC-01 top Issue-1 cause — beyond the alert it may or may not produce.

Guard/gate outcomes are, at best, embedded in free-text `console` lines with no structure and no counters (`C-112`, OBS-6: "escalation/guard-strip/semanticSkipped/[NO_REPLY] rates are free-text only, undetectable as trends"). A classifier that silently fails open (10 of the fallback taxonomy) leaves no trace distinguishable from a classifier that legitimately returned false.

### (5) Decision points (escalation triggers) — **PARTIAL**

Escalations *do* leave a durable row: `ai_alerts` (reason, conversation_id, message_id, status). This is the strongest surviving signal — Phase 4 could reconstruct escalation position (14/20 at final turn, EV-014) purely from these rows. But three structural gaps cripple forensic use:
- **`details` only exists from migration `059_order_info_update_details.sql` (the 2026-06-23 boundary).** All 6 usage alerts and the 4 early product alerts predating it have `details = NULL` — **unclassifiable** (EV-011/012). The `fcd0af7e` incident is reconstructable *only because* it fired on `2026-06-23T16:33:39Z`, effectively the day the column began populating.
- **The fail-closed-vs-genuine distinction is invisible.** An `ai_alerts` row carries no field recording whether the escalation was a genuine model judgment or a mechanical fail-closed default on transport/parse error. RC-01's assessor (`productInformationGapService.ts:105`) and RC-19's umbrella catch (`processAIReply.ts:1379-1948`) both produce (or suppress) escalations on *degradation*, and the alert row looks identical to an honest one. So the central finding of this whole audit — that dev "hallucination" alerts are mechanical false positives against active catalog rows (RC-02; EV-011/013: every "hallucinated" name/price matches a real in-stock row) — required manual SQL catalog cross-checks (EV-013) that the alert schema itself cannot support.
- Alert content shows an *encoding regression window*: 06-27 fallback messages stored as mojibake (`S� shpejti…`, EV-011) while 06-23 is clean UTF-8 — a defect the telemetry surfaces only incidentally.

### (6) Conversation state (turn / truncation / summarization) — **ABSENT**

No transition in the conversation lifecycle is logged as an event. There is no modeled state machine (`C-04`); state lives across four columns + Redis + BullMQ with writers in 3 controllers and 13 job sites. Specifically un-emitted:
- **Truncation.** The 40-message history window (`AI_HISTORY_FETCH_LIMIT=40`, RC-13, `C-13`→`C-33`) silently drops the oldest turns; nothing records *that* a truncation occurred or *what* rolled out. The `product_ids` anchor emptying on order/escalation turns (10 anchor-loss events, Q3, `C-34`) is observable only by after-the-fact inspection of persisted `product_ids=0` rows, never as a logged event.
- **Summarization.** The deterministic customer-message-only summarizer (`aiService.ts:3049-3090`, `C-31`) emits no record of what it discarded (every assistant turn/price/order detail).
- **Pause / resume transitions.** The six dead-end states (Phase 5; RC-14: `ai_paused`, rate-limit-paused, escalated-resolved-without-resume, silent-active, hold-anomaly, reopened-but-paused) have no transition log. "14/20 alerts fire at the final turn and there is no auto-resume" was reconstructed from `ai_alerts` position + code reading, not from any state-change telemetry. A conversation that goes permanently silent produces **no artifact at all** (RC-21, `C-78`: message persisted, `ai.reply` job never created — "artifact-free silence").

### (7) Queue operations — **PARTIAL**

Infrastructure exists but telemetry does not. BullMQ retains terminal jobs (`redisOptimizedQueueBase.ts:11-12`: `removeOnComplete:100`, `removeOnFail:500`; event stream `maxLen:100`), and Bull Board is mounted. The dev snapshot retained **~79 failed jobs** (EV-042: webhook 30, `offerEmbeddingReconcileFast` cron 20 — a scheduled job failing ~every run — message.inbound 16, ai 7), so the *failed set* is a genuine forensic asset. But:
- **No structured job telemetry or alerting.** Nothing emits per-job outcome/latency/attempt metrics; queue depth, retry storms (RC-05 fresh-attempt reschedules, `C-79`), and rate-counter exhaustion (RC-18, `C-83`) are undetectable as trends.
- **No DLQ anywhere** (`C-87`); the `notifications` queue is dead (no producers). An exhausted `ai.reply` job is customer-invisible with no alert.
- **`failureHandler` misclassifies stall-killed jobs as retryable** (`C-88`), so the exhaustion path that *should* fire an alert doesn't.
- In this env `ADMIN_KEY` is unset (report 10, §Evidence limitations), so even Bull Board — the one queue-observability UI — is unreachable.

### (8) Cache (hits / misses / invalidation) — **ABSENT**

No cache instrumentation exists. A repo-wide search for hit/miss/invalidation logging returns nothing (the only match is a comment in `redisMemoryMonitor.ts:5` about Redis rejected-SET counting, unrelated to app caches). The four prompt-assembly caches with delete-only invalidation + refill-resurrection races (RC-17, `C-53`), the per-process FIFO query-embedding cache (RC-04, `C-129`), the 600s self-echo registry whose miss misclassifies AI as human (RC-24, `C-57`), and the unbounded in-process `availabilityCache` (`C-59`) all operate blind. The RC-17 divergence — two workers assembling different guidelines/persona/model within a 900s window — is *structurally invisible* precisely because neither the cache decision nor the resulting prompt (§15.1(2)) is logged.

### (9) Errors — **PARTIAL**

Errors go to `console.*` (277 sites) and effectively nowhere else. Sentry is initialized once (`instrument.ts:23-37`) with **only** `expressIntegration()` + `setupExpressErrorHandler(app)` — i.e. it captures unhandled errors on the synchronous Express request path. The entire async AI pipeline is outside it: **0 `captureException` calls in `backend/src/jobs`** (confirmed) and 0 in the AI services (`C-110`, OBS-4, **S1**). Consequently:
- The pervasive catch-and-continue lines — RC-19's umbrella `console.warn('…continuing normal flow')` (`processAIReply.ts:1379-1948`), the swallowed purchase-intent throw (RC-22, `C-77` at `:3831-3837`), the swallowed order-forfeiture (`C-89`) — are invisible to error monitoring by construction. A failure is downgraded to a warn string and the job returns green (`C-143`: "failure indistinguishable from success").
- Report 10 confirms Sentry `hillside-6c` carries no meaningful production error history — so in prod the *only* error surface is ephemeral stdout, with no aggregator wired.

### (10) Performance (per-stage latency, token usage) — **ABSENT**

- **Token usage / cost: never captured.** `completion.usage` is discarded at every call site — the main reply reads only `completion.choices[0].message.content` (`:4126`) and drops the rest. On a product billed on AI-created orders (5%) and per-conversation fees, across an 18–25-call fan-out, there is **zero per-conversation LLM cost visibility** (`C-108`, OBS-2). Grep confirms every `.usage`/`*_tokens` hit in the repo is the unrelated `usage_description` product field — no token accounting exists anywhere.
- **Per-stage latency: not instrumented.** The only timing anywhere is retrieval `elapsedMs` (`aiService.ts:751`) and a job-start log with no matching end/duration (`:1150`). The dominant latency term — deep serialized LLM fan-out (`C-121`, S1) plus the fixed 8s debounce floor (`C-123`) — is unmeasured. `finish_reason` is ignored, so silent truncation at `max_tokens:768` (`C-97`) is invisible.

**Category tally:** ABSENT = 5 (prompt, tool/classifier, conversation-state, cache, performance). PARTIAL = 5 (request identity, retrieval, decision points, queue ops, errors). PRESENT = 0.

| # | Category | Verdict | Load-bearing evidence |
|---|----------|---------|-----------------------|
| 1 | Request identity | PARTIAL | traceId per-webhook only; no HTTP req-id; aiService 0 refs (`C-109`) |
| 2 | **Prompt** | **ABSENT** | prompt never logged/persisted/hashed; model/params not logged (`C-107` S1, `C-23`) |
| 3 | Retrieval | PARTIAL | one `[retrieval]` line, no scores/conv-id, stdout-only (`aiService.ts:742`, `C-111`) |
| 4 | Tool / classifier | ABSENT | only a parse-fail warn; decisions/scores unlogged (`intentDetection…:46`, `C-112`) |
| 5 | Decision points | PARTIAL | `ai_alerts` rows, but `details` only ≥2026-06-23; fail-closed vs genuine invisible (EV-011/012) |
| 6 | Conversation state | ABSENT | no turn/truncation/summarization/pause transition events (`C-04`, RC-14) |
| 7 | Queue ops | PARTIAL | BullMQ failed-set + Bull Board, but no metrics/DLQ/alerting (`C-87/88`, EV-042) |
| 8 | Cache | ABSENT | no hit/miss/invalidation logging anywhere (`C-53`, RC-17) |
| 9 | Errors | PARTIAL | console.* only; Sentry Express-only, 0 captureException in jobs (`C-110` S1) |
| 10 | Performance | ABSENT | no token usage, no per-stage latency, no cost (`C-108`, `C-121`) |

---

## 15.2 Reconstruction test — the `fcd0af7e` false-hallucination incident

The most concrete way to score this pipeline is to take the single best-documented real failure and ask, line by line, what current telemetry would let an on-call engineer recover. The incident (Phase 4 Trace 1; EV-011/013/015; alert `ef3393c1`):

> Customer asks (Gheg) "which of those would you recommend?" — `"Cilen mkishe than ti me marr prej qitynve"` (turn 5, no product keywords). The AI drafts a recommendation of **Mega Mass 3kg Qokolad** and **Mass gainer 3kg Qokolad** — the same two products it itself listed at turn 2, both real, active, in-stock, embedded catalog rows (€55 / €52, EV-013). The keyword-less follow-up rotated the per-turn retrieval window to 10 unrelated products (Melatonine, Creatine, C4…). The name guard validated the draft against that rotated window (RC-02, DP-gg-31), found the two names "absent," and **replaced** the correct reply with a holding message (`"Së shpejti do t'ju kontaktojë një specialist…"`). Quality scored 0.20. Alert `hallucinated_product_name` fired.

### What CAN be reconstructed (durable DB side-effects)

- **The 6-turn transcript, verbatim** — from `messages.content` (EV-015). The customer's Gheg follow-up and the holding-message that shipped are both recoverable.
- **That turn 6 was a replaced holding message** — the sent row (`msg 6e9144d7`, `sent_by=ai`, `flagged=false`) contains the fallback text, distinguishable from the draft.
- **The rotated retrieval window** — `messages.product_ids` on turn 6 persists the 10 unrelated UUIDs. You can see the window was 10 items and (by joining to `products`) that they were off-topic.
- **The stripped draft, partially** — `ai_alerts.details` (populated because 06-23 ≈ the `059` schema boundary) carries `catalogNames` (the 10 retrieved), `suspectedNames` (the 2 stripped), and `originalReplyPreview` (**first ~200 chars only**).
- **The quality verdict** — `messages.quality_score = 0.20` on turn 6.
- **That the "hallucinated" names were real** — but only via *manual, audit-time SQL* against `products` (EV-013), not from any telemetry the incident emitted.

### What CANNOT be reconstructed

- **The assembled system prompt for turn 6.** Never logged (§15.1(2)). You cannot confirm which prompt blocks/persona were active, whether the orphan `offers_promotions` directive was injected (RC-26), or whether the business-rules footer was present (RC-25).
- **Which model and temperature actually answered.** Not logged. Given RC-17 (900s delete-only `ai_config` cache carrying `custom_model_id`) and `C-99`, you cannot rule out that a different model/config produced this reply than the tenant's current one.
- **The full original draft.** Only ~200 chars survive in `originalReplyPreview`; the rest is gone. The exact recommendation the customer *should* have received is truncated.
- **The retrieval scores.** `product_ids` gives the 10 IDs but no similarity values — so you cannot see how far the correct products (Mega Mass, Mass gainer) fell below 0.65, nor whether they were rank 11 or rank 300.
- **Whether the semantic arm even ran.** `semanticSkipped` (RC-04 coin-flip) lived only in the ephemeral `[retrieval]` stdout line, uncorrelated to this conversation — unrecoverable.
- **The classifier decision chain** that routed to the name guard (attribute-intent, gap assessor, etc.) — unlogged (§15.1(4)).
- **Whether the guard fired genuinely or fail-closed.** The `ai_alerts` row has no field for this (§15.1(5)).
- **Token usage / latency / cost** of the turn — never captured (§15.1(10)).

### Why this is damning

The reconstruction above succeeded **only** because of three accidents of the dev environment, none of which hold in production:

1. **It fired on 2026-06-23** — the day `ai_alerts.details` began populating (migration `059`). The 6 usage + 4 early product alerts that predate it have `details=NULL` and are **unclassifiable**. An identical incident a week earlier would be a bare `reason` string with no draft, no retrieved set, nothing.
2. **Auditors ran interactive SQL** against `products` (EV-013) to prove the names were real. No production runbook does this; no telemetry surfaces it; the alert asserts "hallucination" and nothing contradicts it.
3. **The `[retrieval]`/pipeline stdout was long gone** — no aggregator is wired, Sentry is Express-only (§15.1(9)), so even the ephemeral signals that *did* exist at runtime (semanticSkipped, per-source counts) were unavailable minutes later.

So: **the incident is reconstructable in the audit, and would be effectively unreconstructable in production.** The gap between those two states — interactive dev SQL + a lucky schema date vs. a production on-call with only ephemeral stdout and an Express-scoped Sentry — is the precise measure of this pipeline's observability debt. And because the alert itself is a *false positive against active catalog rows* (RC-02), the current telemetry does not merely fail to explain the incident — it actively *misreports* a correct AI reply as a hallucination, with no field an operator could use to doubt it.

---

## 15.3 Recommended AI-observability improvements (direction)

Direction only — Phase 16 specifies mechanisms, sequencing, and schema. These follow the Phase 12 hybrid recommendation, whose substrate is explicitly an **outbox / snapshot / decision-ledger** for observability + atomic writes (not full event sourcing) and a generation `facts_used` contract (validate structured declarations, not free-prose). The five mandated tracks:

1. **Structured logging.** Replace free-text `console.*` with a structured logger emitting JSON events keyed by a correlation id on **every** AI-path line (retrieval, each classifier, generation, each guard, send, draft-order). Redact PII at the boundary (`C-113`/OBS-7 — customer text/phone/address currently cleartext to stdout). Wire a log aggregator so lines survive container recycles (the `[retrieval]` signal is currently write-only). Direction, not the top priority — the top priority is persisting the inputs (#5), because structured logs of a discarded prompt still can't reconstruct it.

2. **Distributed tracing.** Extend a single correlation id from HTTP request **and** webhook receipt through the BullMQ boundary into `aiService` and every classifier (today `traceId` is webhook-only and dies at the service boundary, `C-109`). One trace should span the full 18–25-call fan-out so the serial-latency profile (`C-121`) and the branch actually taken are recoverable. Per-message (not per-webhook-delivery) granularity, so burst-merge (RC-05) doesn't collapse identity.

3. **Metrics.** Counters/histograms for the decision and reliability surfaces that are currently free-text: escalation rate by reason and by fail-closed-vs-genuine; guard-strip rate; `semanticSkipped` rate; retrieval-threshold near-miss distribution; queue depth / retry / DLQ; per-stage latency. These convert RC-01/02/14 from "provable only by hand in dev" into standing trends.

4. **Alerting thresholds.** Alert on the failure *classes* this audit found silent: escalation-rate spikes (Issue 2 proxy), divergence/regeneration signals, DLQ growth and stall-killed jobs (`C-88`, no exhaustion alert today), the dead `notifications` queue and absent DLQ (`C-87`), and — for a usage-billed product — token-cost anomalies. Route AI-path errors to Sentry (currently 0 `captureException` in jobs, `C-110`).

5. **AI-specific telemetry** *(the load-bearing track — closes the §15.2 gaps directly)*:
   - **Prompt provenance** — persist or hash-and-store the assembled system prompt + `messages` per reply, linked to the `messages` row (closes the OBS-1/`C-107` S1 gap; makes RC-17/RC-25/RC-26 per-reply-answerable).
   - **Model & params per call** — record model id (incl. `custom_model_id` vs base), temperature, `max_tokens`, and `finish_reason` (closes RC-03/RC-17/`C-97`).
   - **Token usage & cost** — capture `completion.usage` on every call; aggregate per conversation/tenant (closes OBS-2/`C-108`; enables the billing product to see its own COGS).
   - **Retrieval quality** — persist similarity **scores** (not just `product_ids`), threshold outcomes, and whether the semantic arm ran (closes the RC-02/RC-04 blind spots that made `fcd0af7e` require manual SQL).
   - **Model-confidence & decision capture** — log each classifier's raw score, the threshold it was compared to, boost-applied flag (RC-07), and the branch taken (closes §15.1(4)).
   - **Hallucination signals as ground-truth-linked events** — record what the guard compared against (per-turn set vs catalog), so a strip can be re-judged; ideally validate the generation's declared `facts_used` against the catalog (Phase 12) rather than against the rotated retrieval window — which is the RC-02 root cause that produced the `fcd0af7e` false positive in the first place. Add a fail-closed-vs-genuine flag on every `ai_alerts` row so degradation escalations are distinguishable from real ones.

These are directions; the concrete schema (decision-ledger columns, retention, sampling, redaction policy) is Phase 16.

---

*Cross-references: root causes RC-01, RC-02, RC-03, RC-04, RC-05, RC-13, RC-14, RC-17, RC-19, RC-21, RC-22, RC-24, RC-25, RC-26 (`rootcauses/confirmed.json`); component findings C-04, C-23, C-53, C-57, C-59, C-87, C-88, C-97, C-99, C-107 (OBS-1), C-108 (OBS-2), C-109 (OBS-3), C-110 (OBS-4), C-111 (OBS-5), C-112 (OBS-6), C-113 (OBS-7), C-121, C-123, C-126, C-129, C-143 (`component-registry.json`); evidence EV-011, EV-012, EV-013, EV-014, EV-015, EV-025, EV-042 (`appendix-A-evidence-log.md`); decision points DP-gg-14, DP-gg-31, DP-retrieval-14, DP-GPR-28, DP-po-18, DP-iq-15. Phase 09 §Observability, Phase 10 §Evidence limitations, Phase 11 confirmed set, Phase 12 hybrid substrate.*
