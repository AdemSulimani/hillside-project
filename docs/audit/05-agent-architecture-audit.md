# Phase 5 — AI Agent Architecture Audit

> **Evidence base:** All findings below are grounded in source code (file:line cited, branch `main`, commit `a8ceb15`) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts). Dev data demonstrates mechanisms, not production incidence rates. Step ids (S-01…S-74) refer to `02-execution-trace.md`; DP-nn ids to `03-divergence-analysis.md`; EV-nnn ids to `appendix-A-evidence-log.md`. This phase classifies the architecture; alternatives are Phase 12's job and remediation specifics Phase 16's.

---

## Orchestration pattern

**What `processAIReply.ts` actually is:** a **single-turn reactive pipeline** — one inbound message triggers one linear pass (S-14…S-74) that produces at most one customer-visible reply plus side-effects (alerts, pause flags, a draft order). It is not an agent in any established sense:

- **Not ReAct.** There is no thought→action→observation loop. The single main completion (`aiService.ts:4118-4124`, S-42) has no tools, cannot request retrieval, and is never re-invoked on failure. Retrieval happens *before* generation, once, on the raw burst text (S-33–S-36); if it misses, the model cannot ask again — the guards then punish the model for the retrieval miss (EV-011/013/015).
- **Not planner-executor.** No plan artifact exists. Sequencing is hardcoded: 5 pre-reply special paths (S-23–S-29), one generation (S-42), then ~14 post-reply guards in fixed source order (S-45–S-61).
- **Closest established pattern: pipes-and-filters / interceptor (middleware) chain around a single LLM call** — the "guardrails" idiom — embedded in an event-driven job system (webhook → BullMQ `webhook` queue → BullMQ `ai` queue, S-05/S-13).

Where it deviates from a clean pipes-and-filters implementation:

| Property of the pattern | What this code does instead | Evidence |
|---|---|---|
| Filters are pure text→text transforms | Guards perform DB transactions, pause the conversation, reset billing flags, and emit sockets as side-effects of a text substitution | S-45–S-58 template; `processAIReply.ts:2025-2032`, `:2435-2442` |
| A rejecting filter aborts the pipeline | No guard aborts; every escalating guard *replaces* the reply with a holding message and the send proceeds (bypassing its own precheck, `:3070-3077`) | S-62; 02-execution-trace.md preamble |
| Filters are independent and reorderable | Ordering is load-bearing: quality eval runs before the hallucination guards, which then clear its flags (`:2808-2816`); CLAUDE.md §7 documents a different order (D2, orchestration mapper §6) | S-55–S-57 |
| Stage failure has a uniform policy | 3 distinct failure regimes coexist: pre-reply block fail-open as a unit (umbrella catch `:1379`,`:1942-1948`, DP-GPR-28), one guard fail-closed (DP-gg-14), draft-order block fail-silent (`:3831-3836`, DP-po-18) | S-23, S-48, S-69 |
| Deterministic filters | ~42 of 160 registered decision points are `llm-stochastic`; the "filters" are themselves temp-0 LLM classifiers with keyword fallbacks | register census (§Confidence) |

The macro topology (webhook ACK → queue → worker → socket fan-out) is a conventional **event-driven pipeline**; the micro architecture inside the job is a **guard-chain around one stochastic generation**, with 15–70 serialized LLM calls per inbound message on the worst path (orchestration mapper §5).

---

## Agent state machine (reconstructed)

No explicit state machine exists in code. The effective machine is distributed across four `conversations` columns (`ai_paused`, `human_override_until`, `human_replied`, `status`), Redis counters/locks, and BullMQ job state. Reconstructed:

### States

| State | Definition | Persisted where |
|---|---|---|
| **AI-ACTIVE** | `ai_paused=false`, hold null/expired, `status='open'` | `conversations` row |
| **HUMAN-HOLD** (timed) | `human_override_until > now()` — AI defers ~10 min (`HUMAN_HOLD_MINUTES`, `conversationService.ts:359-365`; migration 057 caps legacy holds at 10 min) | `conversations.human_override_until` |
| **AI-PAUSED** (sticky) | `ai_paused=true` — escalation- or rate-limit-entered; **no timer, no cron, no auto-resume anywhere in the codebase** (verified: `ai_paused=false` is written only by the `chatbotControlController.ts:55` toggle (`toggleAiPaused`, `conversation.ts:152-170`), `aiAlertController.ts:115-117` resolve with explicit `resume_ai:true`, `cancellationRefundController.ts:63`) | `conversations.ai_paused` |
| **RATE-LIMITED-PAUSED** | Same column, entered via 25/h counter (`processAIReply.ts:1226-1294`, S-16); the Redis counter expires after 1 h but the pause does not | `conversations.ai_paused` + Redis `ai_rate_limit:{conversationId}` |
| **HUMAN_REPLIED-STICKY** (orthogonal) | `human_replied=true` — never gates replies, only kills use-case billing forever (`aiUseCaseService.ts:283-284`) | `conversations.human_replied` |
| **CLOSED** | `status='closed'` — human-only close (`conversationController.ts:205-233`); **not checked by the reply pipeline's gates** (S-17–S-19 read `is_active`/`ai_enabled`/`ai_paused`/hold, never `status`) | `conversations.status` |
| **FULLY_AI_HANDLED** (orthogonal, one-way) | Set on commissionable order path (`db/models/order.ts:510`), never unset | `conversations.fully_ai_handled` |
| *Transient job states* | FAIRNESS-DEFERRED (E1), LOCK-DEFERRED (E2), HOLD-DEFERRED (E9) — fresh BullMQ jobs, not conversation state | Redis/BullMQ |
| **SILENT-ACTIVE** (*invalid, unmodeled*) | Message persisted but `ai.reply` enqueue lost (DP-iq-15): conversation looks AI-ACTIVE, nothing will ever reply until the next inbound | nowhere — that is the defect |

### Transition table

| # | From → To | Trigger | Where | Deterministic? | Confidence |
|---|---|---|---|---|---|
| T1 | AI-ACTIVE → AI-PAUSED | Any of 13 pausing escalation call sites (10 guard paths, usage variants counted as one; see §Escalation) | `processAIReply.ts:1471, 1530, 1741, 2025, 2079, 2147, 2188, 2435, 2534, 3270, 3313, 3357, 3397` | **Probabilistic** for 8 guard paths (LLM confidence gates >0.7/0.8/0.82 with 0→0.9/0.85 boosts); deterministic for price-guard and uncertain-answer (rate-limit pause is T2) | High (all sites read) |
| T2 | AI-ACTIVE → RATE-LIMITED-PAUSED | 26th job attempt in 1 h (counter INCRs per *attempt*, pre-gate — stale/skipped jobs consume budget, DP-iq-21) | `:1226-1294` (S-16) | Deterministic given counter state | High |
| T3 | AI-ACTIVE → HUMAN-HOLD (+ human_replied=true) | Human replies from inbox | `conversationController.ts:144, 189` | Deterministic | High |
| T4 | AI-ACTIVE → HUMAN-HOLD (+ human_replied=true) | FB/IG echo classified as human agent — including the AI's **own reply** on echo-registry miss (DP-iq-11/12) | `processInboundMessage.ts:806-819` | Deterministic on payload, but the classification heuristic (no `app_id` ⇒ human) is wrong for IG | High (invalid-entry path verified) |
| T5 | HUMAN-HOLD → AI-ACTIVE | Clock expiry — pure comparison at read time, no row update needed | `:1327`, `:379` | Deterministic | High |
| T6 | HUMAN-HOLD → HOLD-DEFERRED job | `rescheduleReplyAfterHumanHold`: only if remaining ≤ hold+60 s, job is for latest inbound, no human outbound after it | `:430-476` (S-19) | Deterministic (3 clock/state conjuncts) | High |
| T7 | AI-PAUSED → AI-ACTIVE | Human toggle; alert resolve **with `resume_ai:true`** (resolve alone does *not* resume, `aiAlertController.ts:93-117`); cancellation/refund resolution. Unpause also clears any hold (`conversation.ts:103`) | `chatbotControlController.ts:55`; `aiAlertController.ts:116`; `cancellationRefundController.ts:63` | Deterministic, human-initiated only | High |
| T8 | any → CLOSED | Human close endpoint (also force-enqueues use-case eval, jobId-deduped) | `conversationController.ts:210-227` | Deterministic | High |
| T9 | CLOSED → open | **Any inbound message** — the conversation upsert unconditionally sets `status='open'` on conflict; `ai_paused` is *not* cleared | `conversation.ts:28-48` (`DO UPDATE SET status = EXCLUDED.status`); `processInboundMessage.ts:593-598` | Deterministic | High |
| T10 | AI-ACTIVE → AI-ACTIVE (human_replied=false) | 9 escalation transactions actively *reset* the sticky billing flag | `:1531, 1742, 2026, 2080, 2148, 2189, 2436, 2535, 3358` | Probabilistic (gated by the LLM triggers) | High |
| T11 | job → FAIRNESS/LOCK-DEFERRED loop | Tenant slot cap (8) or conversation lock busy → fresh job +3 s, **fresh attempts counter, no jobId** | `:1152-1222` (S-14/S-15; DP-iq-19/20) | Deterministic | High |
| T12 | AI-ACTIVE → SILENT-ACTIVE | Throw between message persist and `ai.reply` enqueue + global dedup on retry | DP-iq-15 (S-13) | Timing-window | High (mechanism), unobserved in dev data as artifact-free by definition |

### Text diagram

```
                        ┌──────────────────────────────────────────────────┐
                        │                    AI-ACTIVE                     │
                        │  (ai_paused=false, no hold, status='open')       │
                        └───┬──────────┬──────────────┬───────────┬────────┘
      human reply / echo    │          │ 13 escalation│           │ enqueue lost (DP-iq-15)
      (T3/T4, determ.)      │          │ sites (T1,   │ 25/h cap  ▼
                            ▼          │ mostly LLM-  │ (T2)   SILENT-ACTIVE ──next inbound──▶ AI-ACTIVE
                     ┌────────────┐    │ gated)       │        (dead end until customer retries)
   clock expiry      │ HUMAN-HOLD │    ▼              ▼
   (T5, automatic) ◀─┤ (~10 min)  │  ┌──────────────────────────┐
                     └────────────┘  │  AI-PAUSED (sticky)      │◀─ rate-limit variant:
                                     │  NO auto-resume;         │   Redis counter expires (1h),
                                     │  human-only exits (T7):  │   pause does NOT
                                     │  toggle / resume_ai=true │
                                     └──────────────────────────┘
   any state ──human close──▶ CLOSED ──any inbound──▶ status='open' (pause SURVIVES reopen, T9)

   orthogonal sticky flags: human_replied (set T3/T4; reset by escalations T10) · fully_ai_handled (one-way)
```

### Anomalies

**Dead-end states** (no automatic exit):

1. **AI-PAUSED after escalation** — verified: no scheduler, worker, or cron writes `ai_paused=false`; the only exits are three human-initiated endpoints (T7). The customer holds a promise ("a specialist will contact you") that no system state tracks; 16/20 dev alerts sit at/within one message of conversation end (EV-014, EV-023; Phase 4 mode 5).
2. **RATE-LIMITED-PAUSED** — the 1 h Redis window resets, the pause persists; nothing re-evaluates it (S-16).
3. **Escalated, alert resolved without `resume_ai`** — the alert leaves the queue (status `resolved`) while the conversation stays paused; the UI signal that work is pending disappears (`aiAlertController.ts:106-117`).
4. **SILENT-ACTIVE** — persisted inbound with no job and no artifact (DP-iq-15); dev data shows unanswered final customer messages consistent with this shape (EV-023 `fires_at > total`; Phase 4 mode 10).
5. **Hold-anomaly silence** — `rescheduleReplyAfterHumanHold` declines when the hold exceeds `HUMAN_HOLD_MINUTES + 60s` (`:438-445`); the inbound is never answered by any job.

**Invalid transitions / states:**

- **Holding-message-sent-but-not-paused**: wrong-product and post-purchase escalations send the holding message even when the pause+alert transaction rolled back (DP-GPR-21) — the customer is told a human will follow up while the conversation remains AI-ACTIVE and the next message gets a normal sales reply.
- **Refund demand → normal sales reply**: the umbrella catch (`:1379`, `:1942-1948`, DP-GPR-28) drops the entire pre-reply escalation subsystem as a unit on any throw inside it — no pause, no alert, execution continues to `generateReply`.
- **AI's own reply → HUMAN-HOLD + human_replied=true** (T4 invalid entry): echo-registry TTL miss reclassifies the bot as a human agent (DP-iq-11/12) — a state transition triggered by the system observing itself.
- **Order mutated in a path that then exits silently**: order-info-update writes the order *before* the send precheck (E23, `:1851-1871`, DP-GPR-27).
- **Reopened-but-paused** (T9): a closed, paused conversation reopened by an inbound remains permanently silent while displaying `status='open'`.

**Looping states:** fairness/lock deferrals re-add *fresh* jobs every 3 s with fresh attempt budgets and no jobId (DP-iq-19/20) — unbounded across reschedules, bounded in practice only by the 300 s lock TTL and slot TTL backstops (S-74). The hold reschedule likewise adds a fresh job (DP-iq-25).

**Unreachable/vestigial:** `isProductKnowledgeQuestionUnanswered` (`aiService.ts:2396`) is exported and never called — dead code (verified: single reference in the codebase is its definition). `fully_ai_handled` is reachable but write-only-true and consumed by no gate in the reply pipeline.

---

## Decision points: LLM vs deterministic

Classification of every major runtime decision. **Class key:** `CODE` = pure code/DB; `LLM→θ` = threshold applied to LLM output; `LLM` = LLM verdict used directly. **▲** marks decisions where LLM reasoning decides something a database lookup or the pipeline's own state already answers (9 rows). **▼** marks deterministic logic gating something inherently semantic.

| Decision | Class | Site | Flag |
|---|---|---|---|
| Reply at all (tenant/channel/conversation gates, hold) | CODE | S-17–S-19 | |
| Rate-limit pause | CODE | S-16 | |
| Skip reaction/emoji/empty/stale | CODE | S-21 | ▼ evaluated on the *merged burst* text, a semantic judgment made by `startsWith`/emoji regex (DP-GPR-13/33) |
| Burst near-duplicate merge | CODE (Jaccard ≥0.82) | S-20 | ▼ |
| Reply language | LLM (heuristic fallback) | S-22 | |
| Cancellation/refund route | LLM→θ (>0.8, 0→0.9 boost) | S-23; `aiService.ts:2509-2511` | |
| Wrong-product route | LLM→θ (>0.8, 0→0.9 boost) | S-24; `aiService.ts:2584-2586` | |
| New-order / affirmation veto over pre-reply paths | LLM ×2 (affirmation >0.7, **no boost**) | S-25 | |
| Post-purchase route | regex cue **then** LLM→θ (>0.8, boost) | S-26; `:1020-1030` | ▼ regex `hasPostPurchaseIssueCue` vetoes the semantic detector |
| Delivery-ETA auto-reply | LLM→θ OR regex (regex alone suffices) | S-27; `:1032-1046` | ▲ the *answer* is a `tenants.delivery_time` column read; the LLM classifier is redundant with its own deterministic co-trigger |
| Order-info update + field extraction | LLM→θ (>0.82, 0→0.85 boost) writes LLM-extracted values into the order | S-29; `aiService.ts:2888` | |
| Which retrieval mode (semantic vs lexical-only) | CODE — but effectively a **timing coin-flip**: non-aborting 5 s embedding race + per-process cache (DP-retrieval-01/03/23) | S-33 | ▼ whether *meaning-based* search runs is decided by a timeout |
| Retrieval ranking (RRF fusion, category drops semantic) | CODE | S-35 | |
| Products in context (persisted `product_ids` rehydration, fallbacks, full-catalog fallback) | CODE | S-36 | ▼ the full-catalog fallback silently empties `matchedProducts`, disabling the guard suite (DP-gg-31) |
| Price/discount/attribute/other-options routing | LLM ×4 (kw fallback) | S-32 | |
| Conversation-ending / `[NO_REPLY]` silence | LLM | S-41 | |
| Usage question unanswered | LLM + LLM | S-45 | |
| Usage holding-message fallback (re-check of copy the pipeline itself injects) | CODE detect + LLM re-run | S-47; `:543-567` | ▲ self-knowledge: the system authored the holding messages it asks the LLM to recognize |
| Attribute specified in reply? | LLM (`detectSpecifiedAttributes`) | S-48; `productAttributeAvailabilityService.ts:94` | ▲ flavor/size/color/variant are structured `products` columns |
| Product-info gap (escalate?) | LLM→θ, **fail-closed** | S-48; `productInformationGapService.ts:79` | |
| Speculative health advice | LLM + catalog exemption | S-49 | |
| Is this reply an order confirmation? (format injection) | LLM | S-50 | ▲ the pipeline's own draft-order/data-confirmation state knows this |
| Has assistant already asked the closing question? | regex, then **LLM per unmatched assistant message ×2 passes** (~40 calls worst case) | S-52/S-70; `:740-751` | ▲ classifying the system's own persisted outbound messages — a flag at write time would answer it |
| Repeated-closing strip | LLM-first | S-53 | ▲ self-output |
| Follow-up-invitation strip | LLM-first | S-54 | ▲ self-output |
| Honest-negative ("we don't have it") eval skip | LLM | S-55; `:2695` | ▲ self-output |
| Quality flag/pause | LLM eval model → flag + θ | S-55 | |
| Price hallucination | CODE (string/price match) **against the per-turn retrieval set** | S-56; `priceConsistencyGuard.ts` | ▼ deterministic logic answering the semantic question "is this price true?" from the wrong ground set |
| Product-name hallucination | LLM **against the per-turn retrieval set** | S-57; `aiService.ts:3381-3444` | ▲ **prime case** — a `products` lookup (tenant-scoped ILIKE/trgm over active rows) would verify truth; instead an LLM compares against ≤10 retrieved rows, so retrieval misses convert correct answers into escalations (EV-011/013/015) |
| Uncertain-answer escalation | CODE (phrase list, env-gated) | S-58 | ▼ |
| Create draft order? | LLM→θ (`intent_score>0.85`) ∧ 6 more conjuncts (mixed LLM booleans + CODE) | S-69/S-70; `:3605-3612` | LLM booleans `hasDeliveryAddress/Phone/Name` overlap with regex/persisted contact and order fields already used as fallbacks (`:3536-3545`) |
| Which product/variant for the order | CODE (`resolveOrderProduct`) | S-71 | |
| Commissionable? | CODE (NOW()-relative session window, post-send) | S-73; `:501-541` | |
| Pause on escalation | CODE (consequence of the above triggers) | T1 sites | |

**Summary counts:** register-wide, 42/160 decision points are `llm-stochastic`; within the pipeline's ~34 major decisions above, 12 are LLM or LLM→θ routing decisions, ~9 are LLM decisions answerable by a lookup or the pipeline's own state (▲), and 6 are deterministic mechanisms gating inherently semantic judgments (▼). The two flag directions compound: retrieval (a timing-dependent deterministic subsystem) decides what the semantic guards may treat as true, while LLM calls re-derive facts the database already holds.

---

## Memory lifecycle

**Per-turn context assembly** (S-20, S-38–S-40): each job re-reads the last 40 messages (`HISTORY_FETCH_LIMIT`, `aiService.ts:108-112`), keeps the last 10 raw (`RECENT_RAW_HISTORY_MESSAGES=10`, `:98`), deterministically summarizes older rows, and truncates to a 6000-token history budget (`:92-97`) under a chars/4 estimate — while the system prompt itself (26–33K chars) is unbudgeted (findings-seed, prompt section). Nothing persists what the model actually saw; window positions in Phase 4 are positional reconstructions (04-multiturn-quality-audit.md, Method).

**Anchor persistence:** `messages.product_ids` on each outbound AI row is the *only* persisted link between a reply and the products it discussed (`processAIReply.ts:3189-3212`; Phase 4 §state management). It is deliberately **emptied on holding/escalation turns** (`:3211`, DP-retrieval-12) and empirically empty on order-flow turns (10 anchor-loss events across 6 dev conversations, EV-019) — i.e. the anchor disappears exactly where continuity matters most. Rehydration (`findActiveProductsByIds`, DP-retrieval-13) silently drops rows, and escalation-heavy stretches roll the last anchored recommendation out of the 40-message window, ending follow-up chains at a fail-closed classifier (DP-12/14/15) — the AI can then deny products it just recommended (Phase 4 Trace 3, 8 dev conversations).

**What is never remembered:**
- **Facts** — no summary store, no fact memory; quoted prices and discussed products live only in raw message text (Phase 4 §state management). The single cross-turn consistency check covers *prices only*, look-back 6, single-price replies only (`conversationFactConsistencyGuard.ts:26-28,54,75`).
- **Corrections** — a guard or customer correcting the AI leaves no state; classifier results are never cached across the 15–70 calls of a turn or across turns.
- **Escalation promises** — "a specialist will contact you" creates an alert row with no linkage back into the conversation (Phase 4 mode 5).

**Memory contamination paths** (cross-cite Phase 4):
1. **Flagged-reply re-feed** — history assembly does not filter `flagged` rows; the dev DB's one flagged message sat inside the context window of the next reply (EV-022, DP-pc-14, Trace 2).
2. **Never-delivered replies re-fed** — send-failed outbound rows persist (`:3477`) and re-enter history as assistant turns the customer never saw (DP-pc-14).
3. **Holding-message pollution** — escalation turns feed subsequent windows with "specialist will contact you" copy, which later self-inspection classifiers (S-47, S-52) must then LLM-classify back out.
4. **Cache-layer divergence** — delete-only config/block caches plus the refill-resurrection race mean two workers can assemble different personas/guidelines for the same tenant state (DP-pc-01/02/08).

---

## Confidence & retry strategy

**The confidence-boost quirk (verified):** four detectors overwrite a missing/zero model confidence with a passing value — cancellation/refund 0→0.9 (`aiService.ts:2509-2511`), wrong-product 0→0.9 (`:2584-2586`), post-purchase 0→0.9 (`:2686-2688`), order-info-update 0→0.85 (`:2888`) — guaranteeing their `>0.8`/`>0.82` gates pass whenever the boolean is true. `detectOrderAffirmationIntent` **lacks the boost** (`:2751-2771`: confidence-omitted output stays 0, failing its `>0.7` gate) — so escalation-type detectors fail toward *acting* and the order-affirmation detector fails toward *not ordering* (DP-GPR-16, DP-po-30): asymmetric fail directions on gates that look symmetric.

**Threshold knife-edges:** >0.7 (affirmation), >0.8 (cancellation/refund, wrong-product, post-purchase, ETA), >0.82 (order-info), >0.85 strict (`intent_score`, S-70), 0.65 similarity post-filter (S-35), 0.1 quality floor. All strict inequalities on stochastic outputs; identical order-ready turns flip order/no-order across the 0.85 edge (DP-po-30, EV-025). The eval model additionally mis-scores an entire reply class — every dev order confirmation scored 0.200 (EV-018), and the one flagged dev message was a confirmation flagged `unclear` (Trace 2) — so the threshold sits under a systematically biased distribution.

**Agent-level retry: none.** No guard ever re-generates: a failed draft is *replaced* with canned copy, never retried with better context (S-45–S-58). No classifier is re-asked; no retrieval retry follows an empty result (the zero-hit "self-heal" reformulates once inside S-36 but there is no generate→check→regenerate loop). The only retries are infrastructure-level: BullMQ job attempts (which re-run the *whole* pipeline, re-executing rate counters, LLM calls, canned sends and alert inserts — DP-iq-26, DP-po-09/10/11) plus SDK-internal 60s×3 transport retries, and the self-reschedules (T11) that mint fresh attempt budgets. Retry exists below the semantic layer and nowhere within it.

**Fail-open/fail-closed census** (register `merged.json`, 160 rows): **79 fail-open, 32 silent-drop, 8 throw-retry, 6 fail-closed, 35 n/a.** The 6 fail-closed points: webhook staleness 403 (DP-iq-02), rate-limit pause (DP-iq-21), the empty-retrieval safety-net classifier (DP-retrieval-15), the product-info-gap assessor (DP-gg-14), and the two purchase-intent failure modes (DP-po-18/19 — whose "closure" is *silent order forfeiture*, swallowed at the `processAIReply.ts:3831-3836` catch of the draft-order try block opening at `:3510`). The gap assessor is the pipeline's **only fail-closed guard**: an OpenAI degradation converts every product question into holding+pause+alert while every neighboring guard fails open on the same event (DP-gg-14) — the system's posture under provider failure is "sell unguarded, except product questions, which all escalate."

---

## Escalation logic

**Complete trigger inventory — 14 alert reasons** (all `createAIAlert` call sites verified):

| # | Reason | Trigger site | Detection class | Pauses AI? | Resets `human_replied`? |
|---|---|---|---|---|---|
| 1 | `rate_limit_exceeded` | `processAIReply.ts:1259` | CODE (counter) | **Yes** (`:1251`) | No |
| 2 | `cancellation_request` | `:1456` | LLM >0.8 (boosted) | **Yes** (`:1471`) | No |
| 3 | `refund_request` | `:1466` | LLM >0.8 (boosted) | **Yes** (`:1471`) | No |
| 4 | `post_purchase_support_request` | `:1537` (wrong-product), `:1748` | LLM >0.8 (boosted) | **Yes** (`:1530`,`:1741`) | **Yes** (`:1531`,`:1742`) |
| 5 | `order_info_updated` | `:1895` | LLM >0.82 (boosted) | No | No |
| 6 | `usage_question_unanswered` | `:2032`, `:2086`, `:2154`, `:2195`, `:2541` (health-advice reuses it) | LLM chain | **Yes** | **Yes** |
| 7 | `product_question_unanswered` | `:2442` | LLM, **fail-closed** | **Yes** (`:2435`) | **Yes** (`:2436`) |
| 8 | `product_image_unavailable` | `:3224` | CODE | No | No |
| 9 | `hallucinated_price` | `:3265` | CODE vs retrieval set | **Yes** (`:3270`) | No (S-56) |
| 10 | `hallucinated_product_name` | `:3308` | LLM vs retrieval set | **Yes** (`:3313`) | No (S-57) |
| 11 | `uncertain_answer_escalated` | `:3342-3381`; constant `uncertainAnswerFallbackGuard.ts:54` | CODE (phrase list) | **Yes** (`:3357`) | **Yes** (`:3358`) |
| 12 | *dynamic quality flag reason* (e.g. `unclear`) | `:3388-3397` | Eval model | **Yes** (`:3397`) | No |
| 13 | `message_send_failed` | `:3489` | CODE | No — and **no re-delivery** (S-68) | No |
| 14 | `token_refresh_failed` | `refreshMetaTokens.ts:136` | CODE (cron) | n/a (system alert, no conversation) | n/a |

(`escalationController.ts:13` additionally lets tenant staff create manual `usage_question_unanswered` alerts.)

**Asymmetries:**
- **Pause:** 10 conversation-scoped reasons pause; `order_info_updated`, `product_image_unavailable`, and `message_send_failed` do not. The non-pausing set is empirically the only alert class conversations survive (`product_image_unavailable`: both early dev alerts, conversation went on to place two orders — EV-023, Phase 4 Trace 4).
- **Billing flag:** escalations #4, #6, #7, #11 reset `human_replied=false` (re-arming use-case billing) while the hallucination guards #9/#10 and quality #12 do not — three pause paths strand the billing flag wherever it was (S-56/S-57 "no human_replied reset").
- **Alert placement:** pre-reply and usage/gap guards create the alert *before* the send against the inbound message id; price/name/uncertain/quality alerts are created *after* persist against the outbound id, each in its own transaction that can fail independently of the already-sent holding message (S-66; orchestration mapper §7).
- **Fail direction:** the entire pre-reply escalation family fails open as a unit (DP-GPR-28); the gap assessor alone fails closed (DP-gg-14).

**Terminal-alert pattern (verified against dev data):** 14 of 20 dev alerts sit at the conversation's final message and 16/20 at/within one message of the end; 4 are mid-conversation, 2 early (EV-014, EV-023). The causality is alert → end, not depth → alert (Phase 4, Degradation thresholds Q7): 10 of 14 reasons pause the conversation, `ai_paused` has **no auto-resume** (verified above — the only `ai_paused=false` writers are three human-initiated endpoints), the holding message promises contact that no state tracks, and closed/paused conversations reopened by a follow-up stay paused (T9). Escalation is architecturally a one-way door dressed as a hand-off.

**Escalation-cascade × anchor interaction:** every escalation persists `product_ids=[]` (`:3211`), so a single guard misfire simultaneously (a) pauses the AI, (b) deletes the product anchor the *next* turn would need, and (c) injects holding-copy into the history window (memory contamination §3). If a human resumes the AI, the first customer follow-up meets a conversation whose retrieval anchor is gone and whose recent history is escalation boilerplate — the state the fail-closed follow-up classifier chain handles worst (DP-12/14/15; Phase 4 Trace 2: double-alert cascade `18129839`).

---

## Hallucination root-cause attribution

Attribution of every hallucination class observed in evidence to the mandated categories: *missing/failed retrieval · ranking · prompt ambiguity · model reasoning · memory contamination · agent decision logic · business rules · multi-turn degradation*.

**Headline finding first: all 3 dev-DB "hallucination" alerts are guard false-positives — retrieval failures, not model fabrications** (EV-011/013/015). The "hallucinated" €18.00 prices exactly match active catalog rows (Carbo one Limon/Portokall); the "hallucinated" names (Mega Mass 3kg Qokolad, Mass gainer 3kg Qokolad) are real, active, embedded products the AI itself had named two turns earlier. In both cases a keyword-less follow-up emptied/shifted the per-turn retrieval set and the guards validated truth against that set instead of the catalog.

| Class (evidence) | Primary cause | Secondary | Explicitly *not* |
|---|---|---|---|
| False-positive `hallucinated_price` alerts — correct €18.00 suppressed (EV-011, EV-015; conversations `3ea2ace9`/`cf2bf59a`) | **Agent decision logic** — price guard grounded on per-turn retrieval set (`processAIReply.ts:2789-2837`) | **Missing/failed retrieval** — keyword-less follow-up returned nothing (DP-retrieval-01/03/23) | Model reasoning (the price was right) |
| False-positive `hallucinated_product_name` alert — AI's own turn-2 recommendation stripped at turn 6 (EV-011/013; Phase 4 Trace 1, `fcd0af7e`) | **Agent decision logic** — name guard compares against the 10-row retrieval window (`:2847-2883`) | **Multi-turn degradation** — anchor `product_ids` present but retrieval re-ranked to unrelated top-10 on "which would you recommend" (DP-retrieval-14, DP-gg-31) | Model reasoning |
| Denial-after-recommendation — "those products aren't in our catalog" two turns after recommending them (Phase 4 Trace 3; 8 dev conversations, EV-018) | **Missing/failed retrieval** on keyword-less follow-ups + **multi-turn degradation** (anchor emptied/rolled out, EV-019) | **Prompt ambiguity** — the prompt instructs grounding in provided context, so the model *correctly* denies knowledge of products retrieval failed to supply; no guard fires, the contradiction is invisible | Memory contamination |
| Unvalidated real-name sends & orders — "Mass Gainer Pro" sold across 6 conversations with the guard suite silently disabled (Phase 4 Trace 5, EV-018/EV-025) | **Agent decision logic** — full-catalog fallback empties `matchedProducts`, disabling every hallucination guard exactly when retrieval failed (DP-gg-31) | — | A hallucination at all (row was live at conversation time) — but only by luck |
| Inexact naming — "Optimum Nutrition Gold Standard Whey" for catalog rows named "Gold standard whey" (`509f4690`, EV-025) | **Model reasoning** — brand-completion from priors | **Ranking/retrieval** put related rows in context; guard suite was disabled (same DP-gg-31 state) | — |
| Wrong-product answer — L-carnitine answered for "a keni carbo one" (`28bec994`, EV-011/EV-025) | **Ranking** — fusion retrieval surfaced the wrong product as top context | **Missing retrieval** of the asked-for row | Model reasoning |
| "No access to prices" / price-capability denials (3 conversations, EV-018/EV-025) | **Prompt ambiguity** + routing — price-intent classifier divergence decides whether price context/instructions are assembled (S-32; DP-po-30-class stochastic conjunctions) | Missing retrieval | — |
| Quality-flagged "unclear" order confirmations scored 0.200 (EV-018; Trace 2) | **Business rules** — eval-model calibration treats a legitimate reply class as failing | — | Hallucination (nothing false was said) |
| Flagged/holding copy re-fed into later replies (EV-022; DP-pc-14) | **Memory contamination** — history assembly filters nothing | Multi-turn degradation | — |
| Mojibake fallback text sent 06-27 ("S� shpejti…", EV-011) | **Business rules** (encoding defect in the fallback path) | — | Model output at all |

**Pattern:** in this evidence base, not one confirmed case is a free-standing model fabrication caught by the guards working as designed. The guard subsystem's observed contribution is inverted — it suppresses correct answers when retrieval fails (rows 1–2) and stands down when retrieval fails *harder* (row 4), because both its trigger and its ground truth are the same per-turn retrieval set. The generative model's own contribution is limited to inexact brand-naming (row 5) and context-faithful denials (row 3) — both downstream of retrieval state.

---

## Pattern fitness assessment

Classification-level observations against the five reference patterns (alternatives are Phase 12's job; remediation specifics Phase 16's):

| Pattern | Fit | Observation |
|---|---|---|
| **ReAct / tool-using agent** | Not present | No act→observe loop; retrieval is a fixed pre-step; guards cannot trigger re-generation or re-retrieval. Ironically, several failure modes (keyword-less follow-up → empty retrieval → false-positive guard) are precisely the shape a retrieve-again loop addresses — the architecture forbids the recovery its failures call for. |
| **Plan-and-execute** | Not present | No plan artifact, no decomposition; multi-episode conversations survive only because customers restate intent at episode boundaries (Phase 4 Trace 4 — "customer-subsidized" coherence). |
| **Deterministic orchestration around LLM leaf calls** | Half-present | The skeleton (gates, ordering, send, order creation) is deterministic code, but ~42 registered decision points delegate *routing* to temp-0 LLM classifiers with knife-edge thresholds, and the deterministic parts (retrieval timing, cache state, NOW()-relative windows) are themselves nondeterministic in effect (03-divergence-analysis.md). |
| **Workflow/state-machine based** | Absent where most needed | Conversation state is four uncoordinated columns + Redis; there is no modeled state for "escalated, awaiting human", no auto-resume, no follow-up tracking — hence the dead-end census above. The state machine in this document exists only as an emergent property. |
| **Event-driven pipeline** | Present at macro level | Webhook→queue→worker→socket is conventional and sound in shape; its defects (fresh-job reschedule loops, per-attempt side-effects, no DLQ) are implementation-level, not pattern-level (findings-seed, queueing). |

**Responsibilities currently in LLM reasoning that are deterministic in nature** (classification only; the 9 ▲ rows of the decision-point table): catalog-truth verification of product names; structured-attribute presence checks; five self-output classifications (order-confirmation shape, negative-availability, closing-question repetition ×2 passes, follow-up-invitation); recognition of the pipeline's own injected holding copy; and the delivery-ETA classification whose deterministic co-trigger already suffices. A tenth, adjacent case: the draft-order completeness booleans (`hasDeliveryAddress/Phone/Name`) re-derive via LLM what regex and persisted contact/order fields partially resolve already (`:3536-3545`). The inverse misallocation is equally load-bearing: deterministic mechanisms (retrieval timing races, the per-turn retrieval set as ground truth, phrase-list escalation, regex vetoes over semantic detectors) currently decide questions that are inherently semantic — the architecture spends LLM calls where the database knows the answer and trusts timing-dependent code where meaning is at stake.

---
*Phase 5 authored 2026-07-11. Source verified at commit `a8ceb15`: pause/resume writers, confidence-boost sites, alert-reason inventory, `rescheduleReplyAfterHumanHold`, conversation upsert reopen semantics, dead-code check on `isProductKnowledgeQuestionUnanswered`, register census from `scratchpad/audit/register/merged.json` (160 rows).*
