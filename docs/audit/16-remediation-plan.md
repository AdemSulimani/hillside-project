# Phase 16 — Prioritized Remediation Roadmap

> **Evidence base:** Grounded in source code (file:line), the dev/staging database, live-replay experiments (Phase 10), and the confirmed root causes of Phase 11. Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md.

---

## How to read this

This roadmap sequences the remediation of the **25 confirmed root causes** (`rootcauses/confirmed.json` — 22 CONFIRMED + 3 WEAKENED: RC-04, RC-09, RC-15) into four priority tiers. Every item is anchored to one or more confirmed RC ids and to the Phase 12 hybrid target (deterministic full-catalog grounding gate, transactional-outbox / decision-ledger substrate, resumable FSM + persisted slot store, and a generation `facts_used` contract).

**Priority definitions**

| Tier | Meaning | Selection rule |
|------|---------|----------------|
| **P0 — IMMEDIATE ("stop the bleeding")** | Stops silent customer harm or revenue loss *happening now*. | Lowest regression risk × highest impact; each independently shippable behind a feature flag; interim precursors to the hybrid build, not the full architecture. |
| **P1 — CURRENT SPRINT** | The hybrid **spine** that closes the two Criticals and the dominant Issue-2 driver at production quality. | The outbox/idempotency substrate, the decision-ledger + PII boundary, confidence-contract symmetry, retrieval reliability, channel-isolation. |
| **P2 — NEXT QUARTER** | Architectural **completion** of the Phase 12 hybrid and scale hardening. | Consolidated grounding gate + `facts_used` contract, full classifier consolidation, memory/history redesign, decision-ledger substrate, Albanian/Gheg program, circuit breakers, config-drift hardening. |
| **P3 — BACKLOG / STRATEGIC** | Multi-sprint programs reaching the hybrid **end-state** and platform-scale foundations. | Deterministic routing collapse, horizontal worker fleet, reversible migration framework, standing eval harness, prompt governance, cost telemetry. |

**This is DESIGN. It is implemented separately.** No product source is edited in this deliverable. Every `file:line` citation is an anchor for the implementer and references commit `a8ceb15`. Each item is independently shippable behind a feature flag and independently replay-testable against the audit's own evidence corpora (IN1/IN3, EV-010/011/013/015, EV-025, the `fcd0af7e` transcript).

**Ordering law (Phase 12 §Migration, RC-23).** `P0-1` (CI runs the 548-suite, deploy gated on CI, safe migration runner) is the **Week-0 prerequisite for every code-touching item in every tier** — "migrating architecture on an ungated pipeline is malpractice." Each field below states `Depends on:` explicitly; the full safe order is in **§ Sequencing & dependencies**.

**Field format.** Every item lists: RCs addressed · Depends on · Strategy · Regression risk · Migration path · Rollback · Validation · Testing · Edge cases.

---

## P0 — IMMEDIATE ("stop the bleeding")

### P0-1 — Make CI run the tests, gate deploy on CI, and make the migration runner safe
- **RCs addressed:** RC-23 (Medium — Week-0 gate)
- **Depends on:** (none — lands first)

**Strategy.** Three independent, config-only changes, zero product-source risk. (1) **Run the suite in CI:** `ci.yml` runs typecheck+build+migration-smoke+health+lint but never `npm test`; Phase 10 proved the suite is real (548 tests / 75 suites / 0 fail, offline in ~6s, no DB/Redis/.env — WF-G). Add a `Test` step to the `backend` job after `Build`, make it a required status check on `main`. (2) **Gate staging deploy on CI:** `deploy.yml` `deploy-staging` triggers on `push` to `main` (`:22-24`) as a *separate workflow with no `needs:`/`workflow_run:` gate* (C-149) — a red-CI commit still deploys. Convert it to `workflow_run` on the `CI` workflow `completed` + `conclusion == 'success'` (keep `workflow_dispatch`); add the same success precondition to the tag/prod path. (3) **Safe migration runner** (`db/migrate.ts`): today it `.sort()`s filenames lexicographically, wraps each file in its own `BEGIN/COMMIT` (not atomic across files), holds no lock, and runs at deploy AND every boot (C-150/C-151). Wrap the run in `pg_advisory_lock` so concurrent boots serialize; add a boot-time fail-fast assertion on duplicate ordinals (today `062`/`063`/`064`/`065` each exist twice — EV-037) and non-monotonic applied order, scoped to CI/pre-deploy and allowlisting the four historical dups so it protects the future without a retroactive break.

**Regression risk.** Very low. (1) is additive/offline. (2) can *block* a deploy that previously shipped — the intended behaviour; escape hatch is `workflow_dispatch`. (3)'s advisory lock is standard; the dup-ordinal assertion is allowlisted to the existing 062–065 so no retroactive fail.

**Migration path.** (a) Add `npm test` step + branch-protection required check → observe pass; (b) advisory lock + dup-ordinal assertion (allowlist historical dups) → verify migrate green in CI smoke; (c) flip `deploy-staging` to `workflow_run`-gated last, after (a) is a required check.

**Rollback.** Each is a single revert of a workflow/file. No data or schema state involved.

**Validation.** Break one unit test in a PR → CI `backend` job red, merge blocked. Push a red-CI commit to a staging mirror → `deploy-staging` must NOT fire. Add a throwaway `062_dupe_test.sql` → migrate/CI fails fast naming the collision. Confirm the 548-suite count in CI matches local.

**Testing.** This item *is* the test gate. Add one deliberately-failing canary on a scratch branch to prove the gate bites, then delete.

**Edge cases.** `npm test` uses `tsx --test` — match CI Node 22 to local. `workflow_run` on forked PRs has permission nuances — encode "main pushes from the repo only" in the `if:`. The historical-dup allowlist must be committed with the assertion so the first CI run is green.

---

### P0-2 — Repoint the price and product-name hallucination guards at the FULL active catalog
- **RCs addressed:** RC-02 (Critical), RC-04 (removes the guard's dependency on the volatile retrieved set)
- **Depends on:** P0-1

**Strategy.** The single highest-severity false-positive source: the price guard, name guard, and gap assessor all judge the reply against `matchedProducts` (this turn's ~10–25 retrieved rows), so a correct answer about a real active item is stripped/escalated whenever it is outside the window. All 3 dev "hallucination" alerts (EV-011/013/015) are mechanical false positives against active rows; `fcd0af7e` replaced a correct recommendation of two real in-stock products with a holding message. Interim move: validate against a **per-tenant full-active-catalog fact set**, not `matchedProducts`. Price guard (`jobs/processAIReply.ts:2792-2817`, `services/priceConsistencyGuard.ts:112-147`): replace `buildCatalogPriceSet(matchedProducts)` with a set over `products WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active`; `filterHallucinatedPrices` is already pure — only its input changes. Name guard (`processAIReply.ts:2850-2883`, `aiService.ts:3381-3440`): feed the full-catalog normalized name index, fronted by a deterministic `pg_trgm` similarity lookup (pg_trgm 1.6 installed, 5 dormant gin_trgm indexes, `similarity()` called 0× — WF-G). Decouple both guards from `matchedProducts.length > 0` so `usedFullCatalogFallback` empties (`aiService.ts:4139`) no longer silently disable the suite (DP-gg-31). Behind `GUARD_VALIDATE_AGAINST_FULL_CATALOG`.

**Regression risk.** Low and asymmetric: widening the reference set is strictly more permissive — it can only *stop* escalating real facts, never newly escalate a correct reply. Residual: a fabricated price equal to some other active product's price passes; acceptable — the catalog is ground truth. Perf: one cached indexed query per reply.

**Migration path.** (1) Add `listActiveCatalogPricesForTenant` + name-index model fns with Redis cache + invalidation on product mutation (no schema change). (2) Behind flag, repoint price guard first (pure swap), validate on replay, then name guard, then the `usedFullCatalogFallback` decoupling. (3) Add the pg_trgm pre-filter once price is proven. (4) Flip in staging with the EV replay as the gate; then prod.

**Rollback.** Flag off restores `matchedProducts`-scoped validation instantly; each sub-step is an independent flag check.

**Validation.** **Acceptance:** replay EV-011/013/015 → zero hallucination flags. Property test: any active-catalog price/name never flags regardless of the retrieval window (feed empty/rotated `matchedProducts`). Negative: a genuinely fabricated price/name still flags.

**Testing.** Unit `filterHallucinatedPrices` against a full-catalog set; new deterministic trgm pre-filter unit. Integration: guard block with `matchedProducts=[]` + populated catalog. The EV corpus becomes a permanent CI fixture (via P0-1).

**Edge cases.** Multi-currency (€ vs ALL) — keep equal-numeric-value tolerance. Discounted + base both valid. Cache staleness after a price edit — invalidation hook + short TTL bounds a transient (never permanent) flag. Very large catalogs — lean on the trgm index, don't ship thousands of names to the LLM.

---

### P0-3 — Stop the fail-closed gap gate from escalating catalog-answerable questions
- **RCs addressed:** RC-01 (Critical), RC-02 (the assessor is the third window-relative guard)
- **Depends on:** P0-1, P0-2

**Strategy.** `assessProductInformationRequest` (`services/productInformationGapService.ts:66-109`) is the pipeline's only fail-**closed** guard and the top measured Issue-1 driver: live-replay escalated **8/8** on a plain answerable availability question. Two defects: (a) on empty context / empty output / transport-or-parse error it returns `{ok:false}` → the caller escalates (`processAIReply.ts:2416`); (b) the English-prompted stochastic assessor over Albanian text emits spurious `missing` labels (`['marka']` when brand is null for all rows). Two moves: **(1) Fail OPEN on the degradation path** — when the assessor could not actually assess (transport/parse/empty), send the original AI reply as-is rather than escalate (pass `failClosed:false` at `:2352`, or split the return so "errored" ≠ "missing"). **(2) Require deterministic corroboration** — the code already computes `deterministicMissingKeys` from `computeMissingStructuredAttributes` (`:2337-2349`); escalate only when a structured attribute is genuinely absent OR a narrowly-scoped free-form-info gap, never purely on the LLM's `missing`/`!ok` when the deterministic net confirms the asked attributes are present. Behind `GAP_GATE_DETERMINISTIC_FIRST`.

**Regression risk.** Low. (1) only reduces escalations on the error path (the alternative is the correct grounded reply). (2) narrows escalation to deterministic evidence; residual risk is under-escalating a true free-form knowledge gap — mitigated by keeping the free-form branch and by true-gap golden inputs.

**Migration path.** (1) Refactor the assessor to distinguish `errored` from `missing` (additive). (2) Behind flag, fail-open on error → replay IN1/IN3. (3) Deterministic-first gate → re-run golden set with determinism assertion. (4) Staging → prod.

**Rollback.** Flag off restores `failClosed:true` + LLM-driven escalation. Instant.

**Validation.** **Golden-set determinism assertion:** answerable availability/attribute questions (Albanian+Gheg+English), N≥20× each → normal answer, identical decision every run; IN1/IN3 are seeds. Injected-error unit: stub OpenAI to throw → reply sent as-is (fail-open). True-gap test: an attribute genuinely absent → still escalates.

**Testing.** Unit `deriveAnswerabilityStatus` + the deterministic-first gate (pure). Integration: gap block across {ok+complete, ok+missing, errored}. The golden determinism set runs in CI as a permanent RC-01 fixture.

**Edge cases.** Multi-product per-attribute gaps — keep the deterministic per-product pass as the trigger. Free-form info (ingredients/usage) — bounded LLM path under an explicit fail policy, not blanket fail-open. Gheg misfire (EV-010 `["ma shum"]`) — suppressed because it maps to no structured key. Coordinate with P0-2 so the gap gate does not reintroduce a `matchedProducts`-scoped judgment.

---

### P0-4 — Make the pre-reply sensitive-escalation subsystem fail CLOSED
- **RCs addressed:** RC-19 (High), RC-22 (the swallowed intent-detect throw is the same fail-open anti-pattern)
- **Depends on:** P0-1

**Strategy.** `processAIReply.ts` wraps the entire pre-reply special-path block (cancellation/refund, wrong-product, post-purchase, order-info, escalation) in **one umbrella try/catch** (`:1383` … `:1942-1948`) whose catch does `console.warn('...continuing normal flow')` and falls through to `generateReply`. Any throw silently downgrades a **refund/cancellation demand into a normal sales reply, with no alert, no pause, no order flag, and no BullMQ retry** — a compliance risk firing on any transient OpenAI blip. Two moves: **(1) Per-detector inner catch** for the sensitive class that, on error, routes to the **safe escalation path** (pause + `human_replied=false` + alert + holding message) rather than a sales reply. **(2) Umbrella catch re-throws** so BullMQ retries; also fix RC-22's sibling swallow at `:3831` (intent/draft-order `catch → console.error` returns green) to surface as alert/retry. Behind `SENSITIVE_PATH_FAIL_CLOSED`.

**Regression risk.** Medium-low, in the safe direction. On a transient error during sensitive detection the customer gets a holding/escalation message (human alerted) or the job retries — vastly preferable to the current under-escalation. Re-throw means persistent outages retry then dead-letter (visible silence, pairs with P1-2's DLQ) rather than mis-reply. Care: the re-throw must not double-send if a partial ack already went out.

**Migration path.** (1) Add per-detector inner catches (additive; behaviour unchanged while umbrella still catches). (2) Behind flag, re-throw *only* for a failing sensitive detector first (narrowest blast radius), then broaden. (3) Fix the `:3831` swallow. (4) Fault-injection → staging → prod.

**Rollback.** Flag off restores the umbrella `console.warn`+continue. Inner catches are additive and safe to leave.

**Validation.** Fault-injection: stub `detectCancellationOrRefundIntent` to throw on "I want a refund" → outcome is escalate-or-retry (alert, `ai_paused=true`, holding message), never a sales reply. Assert the `:3831` swallow now alerts/retries. Idempotency: a re-thrown retry does not double-persist an already-sent ack.

**Testing.** Unit: each sensitive detector's inner catch → escalation. Integration: full pre-reply block with injected throws at several sites asserting no fall-through. "Refund demand + transient error" becomes a permanent fixture.

**Edge cases.** Partial side effects before the throw — wrap the smallest unit; prefer detect→decide→single-transactional-write. Re-throw must not resurrect RC-20 non-idempotency — scope it *before* any outbound send in the sensitive path. Distinguish a confident negative (proceed) from a thrown detector (escalate-on-error).

---

### P0-5 — AI auto-resume: eliminate the permanent-silence dead-ends
- **RCs addressed:** RC-14 (High — dominant Issue-2 end-state), RC-06 (pause lifecycle read at run time)
- **Depends on:** P0-1, P0-6

**Strategy.** `ai_paused`, the rate-limit pause, and `human_override_until` have **no automatic re-enable** (9 `setConversationAiPaused(...,true)` sites; resume only via `resume_ai:true` in `aiAlertController.ts:115`, which defaults to *leaving the pause on*). With 14/20 alerts firing on the final turn (Q7), a healthy conversation goes permanently silent the moment any guard escalates; the frontend even manufactures the dead-end as the default Close action (C-16, `AIAlertsPage.tsx:330-332`). P0 slice: **(1) Pause metadata** — additive migration `069_conversation_pause_metadata.sql` adding `ai_paused_reason TEXT` + `ai_paused_at TIMESTAMPTZ`, set at each pause site (thread `reason` through `conversation.ts:93`). **(2) Default-resume on non-sensitive alert resolution** — in `aiAlertController.resolve`, when the reason is NOT in `{cancellation_request, refund_request, post_purchase_support_request}`, default `resume_ai` to true unless explicitly false; update the frontend Close default. **(3) Rate-limit-pause auto-expiry** — a new inbound on a `rate_limit_exceeded` pause with an expired 25/h counter and no open sensitive alert clears the pause. **(4) Invariant monitor** — no conversation may remain paused with an inbound newer than `ai_paused_at` and no open sensitive alert. Behind `AI_AUTO_RESUME`.

**Regression risk.** Low-medium, safe direction. Risk is resuming a conversation a human intended to own — mitigated by: sensitive reasons never auto-resume; `human_override_until` still gates within its window; auto-resume triggers on a *new customer inbound* (the customer is still waiting).

**Migration path.** (1) Ship additive migration + thread `reason` (no behaviour change). (2) Behind flag, default-resume on non-sensitive resolution. (3) Rate-limit auto-expiry (depends on P0-6 so the counter is meaningful). (4) Invariant monitor. Staging → prod.

**Rollback.** Flag off restores resume-only-via-explicit. Migration is additive (columns unused when off). Frontend default is a one-line revert.

**Validation.** Non-sensitive reason → resolve without `resume_ai` → `ai_paused` clears and next inbound gets an AI reply. Sensitive reason (refund) → resolve without `resume_ai` → stays paused. Rate-limit: trip 25/h, let the counter expire, new inbound → AI resumes. Invariant scan returns zero violations after / violations before.

**Testing.** Unit: the resume-policy predicate (reason ∈ sensitive? → require explicit; else default-resume). Integration: the three lifecycle scenarios. Regression: "correct-early then escalate then customer messages again" answers the later turn.

**Edge cases.** Legacy pauses `ai_paused_reason=NULL` → treat as unknown → require explicit human resume. REOPENED-BUT-PAUSED (Phase 5 dead-end #6) — auto-resume-on-inbound covers it for non-sensitive reasons. HOLD-ANOMALY-SILENCE (`processAIReply.ts:438-445`) — out of P0 scope (note for P1 FSM), surfaced by the monitor. Race on two inbounds as the pause clears — the per-conversation lock serializes; keep the resume write inside the guarded path.

---

### P0-6 — Count only delivered replies against the 25/h rate limit
- **RCs addressed:** RC-18 (Medium — direct manufacturer of the RC-14 permanent-silence dead-end)
- **Depends on:** P0-1

**Strategy.** The 25/h limiter INCRs once per job **attempt before the enablement gates and staleness guard** (`processAIReply.ts:~1231`, before the `is_active` gate at `~1298`; DP-iq-21). So BullMQ retries, stale-skipped jobs, disabled-AI jobs, and fairness/lock/hold reschedules (which add *fresh* jobs with reset attempt counters — C-79) all burn budget without producing a reply → a busy legitimate conversation trips 25 on phantom increments → persistent `ai_paused` + `rate_limit_exceeded` → (via RC-14) permanent silence. Move the increment to count **only real delivered replies**: rate accounting *after* the gates pass AND after a successful send, keyed idempotently on the inbound/reply message id so a retry does not double-count. Behind `RATE_LIMIT_COUNT_DELIVERED_ONLY`.

**Regression risk.** Low. The cap still limits genuine volume at 25/h; it stops charging for work that never produced a reply. Care: preserve the rolling-1h EXPIRE semantics — set EXPIRE on the first *real* increment, not on attempt.

**Migration path.** (1) Post-send idempotent-per-message increment behind flag, running in parallel with the existing pre-gate INCR under a *shadow* counter for one window. (2) Confirm the shadow tracks real replies, flip the flag, remove the pre-gate INCR. (3) Land before P0-5's rate-limit auto-expiry.

**Rollback.** Flag off restores the pre-gate INCR. Shadow-counter approach means no data corruption during validation.

**Validation.** One inbound retried N times (inject post-send crash) → exactly one budget unit. Stale-skipped / disabled-AI / rescheduled job → zero budget. 26 genuine delivered replies in an hour → the 26th pauses (cap enforced). Shadow comparison: delivered-only ≤ attempt-based, gap = phantom increments eliminated.

**Testing.** Unit: increment predicate (iff gates passed AND send succeeded AND not already counted for this message id). Integration: retry/stale/disabled/reschedule matrix. Regression: a busy-conversation replay that previously tripped the phantom pause stays active.

**Edge cases.** Key on the inbound message id (or reply `external_message_id`) so retries coalesce; WhatsApp's null send-id still needs a stable key. Reschedules are pre-send by construction — post-send placement handles them. A re-thrown P0-4 sensitive-path job that never sent must not increment (guaranteed by post-send placement). Set EXPIRE atomically with the first real increment.

---

### P0-7 — Stop the AI's own Instagram/Facebook echo being misclassified as a human reply
- **RCs addressed:** RC-24 (Medium — silent use-case-fee revenue loss + 10-min AI silence)
- **Depends on:** P0-1

**Strategy.** Native IG/FB echo classification rests on `isHumanAgentEcho(echoAppId)` returning `true` when `app_id` is absent (`webhookNormalizer.ts:92`), backed by a Redis self-echo registry whose read returns `false` on error (`outboundEchoRegistry.ts:53`). IG echoes carry **no `app_id`**, so any registry miss (Redis hiccup, evicted key, TTL expiry, echo-before-persist) falls through to "human agent" at `processInboundMessage.ts:756-806`: the platform's own reply becomes a human reply → sticky `human_replied` (**disqualifies the use-case fee**) + 10-min `human_override` hold + phantom `sent_by:'human'` row. Add **durable content corroboration** before classifying a no-`app_id` echo as human, and make the classification **fail toward "not human"**: reuse `findRecentOutboundMessageByContent` (already used on the non-human branch at `:764`) before `markConversationHumanReplied` (`:806`); harden `wasSelfSentMessageEcho` so a Redis *error* is distinguishable from a genuine miss; add the invariant that `human_replied` must never be set by an outbound the platform sent. Behind `ECHO_DURABLE_CORROBORATION`.

**Regression risk.** Low, revenue-safe direction. The change only prevents the AI's own messages from being counted as human handoffs; it cannot suppress a genuine human reply (whose content won't match a recent AI outbound). Edge: a human typing verbatim the AI's just-sent text within the dedup window — vanishingly rare, low-harm.

**Migration path.** Behind flag: (1) content-corroboration on the human branch; (2) harden the registry read; (3) invariant assertion. Validate on `services/__tests__/messengerEchoClassification.test.ts` → staging → prod.

**Rollback.** Flag off restores app_id-only classification. No schema change.

**Validation.** A no-`app_id` IG echo matching a recent AI outbound → classified NOT human (no hold, no `markConversationHumanReplied`). A no-`app_id` echo matching nothing recent → still human (genuine native-tool reply preserved). Simulated Redis read error → durable content check still prevents false-human. Billing assertion: after an AI reply + IG echo with a registry miss, `human_replied` stays false and the use-case remains eligible.

**Testing.** Unit: extended matrix (app_id present/absent × registry hit/miss/error × content-match/no-match). Integration: inbound echo path with injected registry error. Regression: "AI reply → IG echo with registry miss" asserts no billing disqualification.

**Edge cases.** WhatsApp/Viber have **no** echo handling (inverse defect — note for P1's symmetric echo handling); don't assume Meta-only. Image-reply echoes have a dedicated path (`:713-748`) — don't double-store. Content-match false positive accepted as low-harm (P1's `external_message_id` registry removes even this). `ECHO_DEDUP_WINDOW_MS` (5 min): a reply >5 min after an identical AI message is correctly human.

---

## P1 — CURRENT SPRINT

### P1-1 — Idempotent post-send pipeline (durable staging + transactional outbox + scoped `external_message_id`)
- **RCs addressed:** RC-20 (High), RC-21 (High)
- **Depends on:** P0-1

**Strategy.** Three defects share one root — no atomic boundary around send + persist + side-effects. **(1) Send-before-persist / non-idempotent retry (RC-20):** the outbound send (`processAIReply.ts:~3068`/`:3195`) precedes `createMessage`, and `012_create_messages.sql:5` declares `external_message_id VARCHAR(255) NOT NULL UNIQUE` **globally**. On retry the whole job re-runs — FB/IG/Viber re-INSERT collides on the global UNIQUE and dead-letters a *delivered* reply's side-effects; WhatsApp (null id) inserts a second row with a **freshly-sampled** text ≠ what the customer saw. Persist a **durable reply-staging row before the send**, keyed by `idempotency_key = hash(conversationId, logicalInboundMessageId, replySlot)` (from the logical merged message, **not** the BullMQ attempt); store text + guard verdicts as `staged`, send, flip `staged→sent` and record `external_message_id` in the **same transaction** as an **outbox** row per side-effect. On retry a `sent` row → no-op the send, re-drive only unfinished outbox rows; the persisted text is authoritative (**never re-generate**). **(2) `external_message_id` scope:** replace the global UNIQUE with `UNIQUE(tenant_id, external_message_id)` for inbound dedupe and `ON CONFLICT (idempotency_key) DO NOTHING` for outbound (also closes the C-114 cross-tenant leak). **(3) Persist-then-no-enqueue (RC-21):** in `processInboundMessage.ts:~886-907` a throw between persist and `aiQueue.add` loses the job; retry finds the row and early-returns before enqueue; `webhookController.ts:336` enqueues *after* `res.sendStatus(200)`. Make **persist + enqueue-intent atomic** (`INSERT message` + `INSERT outbox('ai.reply')` in one txn); a relay polls the outbox → `aiQueue.add`; change dedupe to re-check for a live `ai.reply` outbox row and re-enqueue if missing; ACK the webhook only after commit.

**Regression risk.** The relay adds a hop (latency + new failure surface); a crash between `stage` and `send` leaves a resumable `staged` row (bug here risks a double-send). Changing the UNIQUE fails if prod holds legitimate duplicates. Dispatcher non-idempotency would double-fire alerts/commissions. Burst-merge (RC-05) means one reply covers several inbound rows.

**Migration path.** (1) Add outbox + staging tables + `idempotency_key` (nullable) and **dual-write** the outbox in shadow while keeping direct enqueue — verify the relay drains. (2) Add the scoped unique index alongside the global UNIQUE. (3) Flip reply-persist-before-send per channel behind a flag. (4) Switch dedupe to outbox re-check. (5) Drop the global UNIQUE + old direct enqueue. Each step ships independently.

**Rollback.** Every stage is flagged; the relay disables to fall back to direct enqueue; all columns additive/nullable so revert = flags off. No destructive migration until step 5 (separately reversible).

**Validation.** Kill the worker after send / before persist → retry yields exactly one message row matching the *delivered* text and exactly one set of side-effects (RC-20). Throw between persist and enqueue → the `ai.reply` job still runs via the relay (RC-21). Replay the ~79 retained failed jobs (EV-042) → none dead-letter.

**Testing.** Unit (idempotency-key derivation; dispatcher exactly-once; `ON CONFLICT` dedupe). Integration (persist+outbox atomicity; relay drain; debounce race). Chaos/fault-injection as the standing RC-20/21 guard.

**Edge cases.** WhatsApp null send id (key on `idempotency_key`). Burst-merge collapses multiple inbound → key on merged-set/last-inbound id. `channel_id` NULL after disconnect (scoped unique uses `tenant_id`). Outbox relay lag under a Redis stall. A `staged`-but-never-`sent` row after a crash must resume, not duplicate.

---

### P1-2 — Dead-letter queue + failure-classification fix + exhaustion alerting
- **RCs addressed:** RC-21 (artifact-free silence gains an artifact), RC-20 (dead-lettered side-effects surface for replay), RC-18 (rate-exhaustion vs genuine failure)
- **Depends on:** P1-1, P0-4

**Strategy.** The queue layer has **no DLQ, no backpressure, and misclassifies exhaustion** (C-136/C-87/C-88); the `notifications` queue has **zero producers**; an exhausted `ai.reply` job is customer-invisible silence. The reason it's gone unnoticed is the "return success on failure" posture (swallowed throws C-89, non-throwing sends C-90, RC-19's umbrella) — BullMQ almost never sees a real failure. **(1)** Effective only once **P0-4** makes RC-19 re-throw. **(2)** Add a real DLQ: on `failed` after exhaustion (`jobs/failureHandler.ts`, `jobs/workers.ts`) move the payload to a durable `dead_letter` table with `reason/error/attempts/traceId/tenant_id`. **(3)** Fix classification (C-88): stall-killed / `SIGKILL`-truncated jobs (`SHUTDOWN_TIMEOUT_MS=25000` > Docker 10s grace, `server.ts:41`) classify **terminal → DLQ+alert**, not silently retryable. **(4)** Surface the silence: exhaustion → a durable `ai_alerts` row (new reason `ai_reply_undelivered`/`job_exhausted`); revive/replace the dead `notifications` queue. **(5)** Wire monitoring: AI-path errors to Sentry (today 0 `captureException` in `jobs/`, C-110) + DLQ-growth metric; auto-trim the failed set (`removeOnFail:false` → unbounded, EV-042).

**Regression risk.** Alert noise if classification is too aggressive (a transient 5xx must retry, not DLQ on first failure). Operator replay could double-execute non-idempotent side-effects — replay MUST ride P1-1's idempotency. `removeOnFail` change interacts with forensic use of the failed set.

**Migration path.** (1) `dead_letter` table + `failed` listener in record-only shadow. (2) Fix stall-vs-transient. (3) Exhaustion → `ai_alerts` + Sentry-in-jobs. (4) Guarded operator replay (gated on P1-1). (5) Auto-trim + metrics.

**Rollback.** The listener is additive/observational; replay is flag-gated; the old `failureHandler` stays behind a flag.

**Validation.** Inject a persistent throw → a `dead_letter` row + `ai_alerts` row + Sentry event, not a silent green job. Simulate a deploy `SIGKILL` mid-job → terminal classification. Confirm the exhaustion signal reaches the notifications path. Replay EV-042 → clean classification.

**Testing.** Unit (classifier: stalled vs transient vs terminal). Integration (exhaustion → DLQ + alert + Sentry). Regression (deploy-SIGKILL path; the EV-042 corpus).

**Edge cases.** Transient 5xx (retry, not DLQ); RC-18 rate-limit pause must not look like a failure; a partially-run job replays idempotently (P1-1); DLQ growth during an OpenAI incident trips a distinct breaker, not silently filling Redis (SPOF-2).

---

### P1-3 — Confidence-boost symmetry + required-`confidence` contract + threshold hysteresis
- **RCs addressed:** RC-07 (Medium), RC-08 (Medium)
- **Depends on:** P0-1

**Strategy.** The asymmetry is a **code policy, not a model property** (DP-GPR-16: *eliminate*). Four escalation detectors overwrite missing/zero `confidence` to 0.9/0.85 and clear their `>0.8` gate on the boolean alone, while `detectOrderAffirmationIntent` has no boost and *fails* its `>0.7` gate on the identical quirk — over-escalation on four paths, under-created orders on one. **(1) Required-`confidence` output contract:** add a Zod schema + `response_format` so `confidence` is a required range-checked field on every detector; normalize the `>1 ⇒ /100` scale-guess (C-63) inside the contract. **(2) Uniform missing-confidence policy:** remove the inline `0→0.9/0.85` overwrites (`aiService.ts:2509/2584-2586/2686-2688/2888`); for escalation detectors, missing → abstain/ambiguity path (never auto-pass); for the order/affirmation path, missing → the deterministic order-stage slot check (E.164 phone regex + non-empty address + normalized consent lexicon) so a missing field does not asymmetrically forfeit revenue. **(3) Threshold hysteresis (RC-08):** add an abstain band around the hard gates (`processAIReply.ts:1389`, the 0.75-vs-0.85 tension); persist the per-message verdict (ties to P1-1) so retries don't re-roll.

**Regression risk.** Changing the missing-confidence policy changes escalation volume and order-creation rate — a wrong new fail direction could under-escalate a refund (compliance) or shift orders. Co-design with P0-2/P0-4's fail policy so the escalation family is coherent.

**Migration path.** (1) Land the required-`confidence` schema and, via P1-5's ledger, **measure boost-applied frequency in production before changing behaviour** (log-only). (2) Unify the policy behind a flag. (3) Add the hysteresis band. Roll per-detector.

**Rollback.** Flagged; revert to per-site boosts. The schema/logging step is behaviour-neutral.

**Validation.** Feed each of the five detectors `{intent:true, confidence:0}` and `{intent:true}` (missing) → a **single consistent fail-direction** across all five (DP-GPR-16 acceptance). Contract test that the schema makes `confidence` required. Boundary-corpus replay N≥20× near each threshold → deterministic label or explicit hysteresis resolution.

**Testing.** Unit (5 detectors × missing/zero/boundary). Contract (schema required-field). Regression (boundary corpus as a determinism assertion).

**Edge cases.** `confidence>1` (normalize in-contract); ambiguous refund phrasing (ambiguity path, not auto-escalate); Gheg order-affirmation outside the consent lexicon (slot-extraction with a declared fail direction — never silent order creation).

---

### P1-4 — Retrieval reliability (aborting embedding timeout + negative/shared cache + `semanticSkipped` metric + threshold hysteresis)
- **RCs addressed:** RC-04 (WEAKENED)
- **Depends on:** P0-1

**Scoping honesty.** RC-04 is **WEAKENED** — with `text-embedding-3-small` the vector arm rarely clears 0.65 (EV-043), so this is primarily a **reliability / Issue-2 + observability** fix, not an Issue-1 determinism silver bullet.

**Strategy.** `generateQueryEmbeddingWithTimeout` (`aiService.ts:650-664`) resolves `null` on a 5s timeout that **does not abort** the call, `catch→null` swallows errors, and `setCachedQueryEmbedding` runs only on success (`:659`) so a timed-out query re-races every time; the cache is a per-process 256-entry `Map` (`:614-644`) so workers diverge. **(1)** Replace the race with an `AbortController` that cancels the request + bounded backoff on 429/5xx. **(2)** Move the query-embedding cache to **Redis** keyed by `model+text` (workers converge), **negatively cache** a recent timeout/failure (short TTL); fail-open to compute if Redis is down. **(3)** Emit a `semanticSkipped` structured counter + a per-reply ledger field (via P1-5). **(4)** Add a small hysteresis band around `SIMILARITY_THRESHOLD=0.65`. **(5)** Model/threshold re-eval as a *measured* spike (EV-043) — **guard the dimension landmine** (`-large` = 3072 dims vs `vector(1536)`); do NOT ship a model switch in the same PR.

**Regression risk.** A too-tight abort raises the skip rate; the shared Redis cache adds a retrieval-path dependency (mitigated by fail-open) and is a new hot-path consumer against SPOF-2's 192 MB `noeviction`; changing the threshold changes retrieved sets platform-wide (measure, never guess).

**Migration path.** (1) `semanticSkipped` metric + ledger field first (observe the real timeout rate). (2) Aborting timeout + backoff. (3) Shared Redis cache with fail-open. (4) Threshold hysteresis behind a flag. (5) Model/threshold re-eval as a separate spike with a reindex plan.

**Rollback.** Flags; revert to the in-process `Map`; keep the hard 0.65 threshold. Steps additive.

**Validation.** Inject a 6s embedding delay → the request is **aborted** and `semanticSkipped` increments (not a silent `null`); a timed-out query is negative-cached and does not re-race to a different result. Two workers share the cache and converge. Determinism assertion: same query N× → same retrieved set (bounded — no Issue-1 elimination claim).

**Testing.** Unit (timeout/abort, negative cache, hysteresis boundary). Integration (shared cache across workers). Eval (retrieval-stability replay).

**Edge cases.** Redis down (fail-open, never fail the reply); `OPENAI_EMBEDDING_MODEL` changed at runtime (cache key includes the model — `:629-631` — no cross-model mixing); an embedding at the wrong dimension (dimension-landmine guard before write).

---

### P1-5 — AI decision ledger (persist prompt + model/params + token usage + per-decision events)
- **RCs addressed:** RC-03 (record temp/seed/model per message), RC-17 (which model/`custom_model_id` and cached config answered), RC-01 + RC-02 (record what each guard compared against + fail-closed-vs-genuine flag), RC-04 (`semanticSkipped` + scores), RC-22 (billing-decision provenance)
- **Depends on:** P1-1, P1-6

**Strategy.** Phase 15: five observability categories ABSENT. The assembled 26–33K-char system prompt (`aiService.ts:3919-4124`) and the model/params/`completion.usage` of every one of the ~18–25 calls are discarded the instant each call returns (`:4126` reads only `choices[0].message.content`). Introduce an **append-only `ai_decision_ledger`** (per reply, `tenant_id`-scoped) written through **P1-1's outbox** in the same txn as the reply persist. Capture: a **correlation id** threaded from HTTP + webhook receipt through the BullMQ boundary into `aiService` and every classifier (today `traceId` is webhook-only, 0 refs in `aiService.ts`, C-109) at **per-message** granularity; **prompt provenance** (content hash + size-capped redacted copy via P1-6, linked to `messages`); **model & params per call** (id incl. `custom_model_id`-vs-base, temp, seed, max_tokens, `finish_reason` — silent truncation at 768, C-97); **token usage & cost** (`completion.usage`, C-108 — zero COGS visibility today); **retrieval quality** (similarity scores, threshold outcomes, `semanticSkipped`); **per-decision events** (each classifier's raw score, the threshold, the boost-applied flag — the measurement P1-3 needs — the branch taken; a **fail-closed-vs-genuine flag on every `ai_alerts` row**). Records the generation's declared `facts_used` so a guard strip can be re-judged against the catalog.

**Regression risk.** Persisting a 26–33K-char prompt per reply is storage-heavy → hash + sampled copy + retention policy. It **must redact PII first** (P1-6) or the ledger is a fresh GDPR liability on an EU company. The write must be async via the outbox, never inline-blocking the send.

**Migration path.** (1) Thread the correlation id end-to-end (behaviour-neutral). (2) Capture model/params/`usage` into structured logs (no new table). (3) Add the ledger table, write via the outbox. (4) Add the fail-closed-vs-genuine flag to alerts. (5) Metrics + Sentry-in-jobs + thresholds.

**Rollback.** Additive table + flags; disabling ledger writes falls back to structured logs; the correlation id is harmless.

**Validation.** Acceptance = Phase 15 §15.2 reconstruction: replay `fcd0af7e` and assert that **from the ledger alone** the assembled prompt, model/temperature, retrieval scores, `semanticSkipped`, the classifier chain, and the fail-closed flag are all recoverable. Assert `completion.usage` is captured on every call. Assert no cleartext PII (P1-6).

**Testing.** Unit (ledger writer; cost computation; redaction integration). Integration (correlation id spans the fan-out; one ledger row per reply). Replay (the `fcd0af7e` reconstruction as a standing regression test).

**Edge cases.** Burst-merge collapses `traceId` (use a per-message id); `[NO_REPLY]` paths must still write a row so billing-class divergence is visible; oversized prompt (hash + cap); a ledger-write failure must never fail the reply (best-effort via outbox).

---

### P1-6 — PII redaction boundary (logs + durable telemetry + `ai_alerts`)
- **RCs addressed:** RC-03, RC-01, RC-02 (observability-enabler mapping — persisting prompts/decision inputs is only deployable behind redaction on an EU company). Independently closes SEC-5 / OBS-7 (C-113/C-118), a verified GDPR exposure with no dedicated RC id.
- **Depends on:** P0-1

**Strategy.** Raw customer text — names, phones, addresses, health context — is logged cleartext to stdout at ≥4 AI-path sites with no redaction layer (the `[retrieval]` line logs the raw query at `aiService.ts:744`), and `ai_alerts` rows carry customer content (C-113/C-118). **(1)** `utils/redact.ts` — masks Albanian/international phone formats (E.164 + local Kosovo/Albanian forms), emails, and address/PII fields, using **deterministic tokenization** (same phone → same token) so log lines stay joinable without cleartext. **(2)** Apply at three boundaries: every AI-path logger call (replace the raw-query `[retrieval]` log at `:744`); **before** any customer text enters new durable telemetry (a mandatory pass in the P1-5 ledger writer); an `ai_alerts.details` content policy review + backfill. **(3)** Because health context is not a fixed pattern, prefer **allow-listing customer free-text out of logs entirely** (log a hash/reference) over best-effort pattern redaction where feasible.

**Regression risk.** Over-redaction destroys debuggability (mitigated by deterministic tokenization preserving joinability); under-redaction leaves exposure (regex PII detection has false negatives for Albanian address formats and mojibake-corrupted text from the 06-27 encoding regression). Redaction-off must be compliance-gated, not a casual flag.

**Migration path.** (1) Build + unit-test the redactor against Albanian/Gheg name/phone/address/health corpora. (2) Apply to AI-path logs. (3) Wire it as a **mandatory** pass in the P1-5 ledger writer (hard gate). (4) Audit/backfill `ai_alerts.details`.

**Rollback.** The redactor is a pure function; per-site disable is compliance-gated. No schema destruction.

**Validation.** Unit corpus of Albanian names/phones/addresses/health terms → masked. Integration: scrape AI-path logs in a live-replay run → zero raw phone/email patterns. Assert deterministic tokenization (same input → same token). Assert the P1-5 ledger rejects un-redacted customer text.

**Testing.** Unit (redactor coverage + determinism, Albanian/Gheg formats). Integration (log-scrape assertion). Regression (mojibake-corrupted input; health-context free text).

**Edge cases.** Partial phone in free text; health context (favor free-text-out-of-logs); mojibake text breaking regexes; keep a last-4 token for support correlation without cleartext.

---

### P1-7 — SEC-2 unscoped channel resolver (global uniqueness + receipt-time tenant binding)
- **RCs addressed:** RC-09 (WEAKENED — the genuine, latent multi-tenant isolation defect)
- **Depends on:** P0-1

**Strategy.** `findChannelByTypeAndExternalId` (`db/models/channel.ts:119-128`) is `SELECT * FROM channels WHERE type=$1 AND external_id=$2 LIMIT 1` — **no tenant scope, no `ORDER BY`, bare `LIMIT 1`** — and the `channels` UNIQUE key includes `tenant_id`, so nothing prevents two tenants binding the same account; a dual-connected `external_id` routes an inbound (and the AI reply, catalog, persona, and **commission**) to an arbitrary tenant. Latent — dev `channels` is empty (EV-038), so this is code+migration-verified, not runtime-data-verified. **(1)** New migration adding a global `UNIQUE(type, external_id)` scoped to active/non-deleted bindings, preceded by a **detection query + ops resolution** (a blind `ADD CONSTRAINT` fails if prod holds legitimate duplicates). **(2)** Interim determinism: `ORDER BY created_at ASC` (or an explicit `active`/`primary` flag) + log/alert when >1 row matches. **(3)** Receipt-time tenant binding: stamp `tenant_id` onto the inbound job/message so the conversation-scoped history loader (`db/models/message.ts:304-321`, C-116/SEC-3) can't be reached with a mis-resolved tenant. **(4)** Onboarding guard: reject connecting an `external_id` already bound to another tenant.

**Regression risk.** The `UNIQUE(type, external_id)` **fails** if prod has legitimate duplicates → detect + resolve first. It could block a legitimate disconnect→reconnect if the stale binding isn't cleaned → soft-delete the old binding. Interacts with `channel_id` NULL-on-disconnect on contacts/conversations.

**Migration path.** (1) Resolver `ORDER BY` + multi-match alert (immediate, safe). (2) Non-enforcing detection query/dashboard. (3) Ops resolves duplicates. (4) Add the enforcing global `UNIQUE` once clean. (5) Reject dual-connect at onboarding.

**Rollback.** Steps 1–3 additive/observational; step 4 reversible via `DROP`; step 5 flagged.

**Validation.** Resolver returns a deterministic row given two matches. Migration dry-run against a seeded dual-connect → the pre-check catches it and the constraint refuses until resolved. Connecting an already-bound `external_id` to a second tenant is rejected; a webhook for a dual-bound account (pre-constraint) routes deterministically and alerts. **Label results code/migration-verified** (dev channels empty).

**Testing.** Unit (resolver `ORDER BY` + multi-match detection). Integration (onboarding rejection; routing determinism). Migration test (constraint add with/without seeded duplicates).

**Edge cases.** Same page reconnected to the **same** tenant (allowed). Disconnected/`deleted` rows (unique considers active bindings only). Agencies managing multiple businesses (realistic dual-connect). `channel_id` NULL propagation after a binding is removed.

---

## P2 — NEXT QUARTER

### P2-1 — Consolidated deterministic grounding gate + `facts_used` generation contract (retire the guard suite)
- **RCs addressed:** RC-02 (Critical), RC-01 (Critical), RC-03 (High), RC-15 (factual portion)
- **Depends on:** P0-2, P0-3

**Strategy.** The spine of the hybrid and the permanent replacement for the interim P0-2/P0-3 repointing. Collapses the price filter, name filter, fail-closed gap assessor, usage-unanswered chain, and the *factual* portion of the quality eval into **one deterministic gate** validating against the **materialized full-catalog fact index** (built in P1), and flips generation from "sample free prose, then guess the facts" to "declare facts, validate the declaration." **(1) `facts_used` contract:** change the customer-facing completion (`aiService.ts:4118-4124`) to run at `temperature:0` + fixed `seed` + `response_format` `json_schema` returning `{ facts_used:[{type,product_ref,value}], prose }`; the prompt instructs the model it may only state prices/names/attributes present in the injected FACTS block (this is simultaneously the RC-03 fix). **(2) Consolidated gate** replacing the guard block (`processAIReply.ts:2792-2817/2850-2883/2416`) and `productInformationGapService.ts` / the name-validator: extract asserted facts (`facts_used` + a deterministic prose backstop via `pg_trgm`); validate against the full active-catalog index (never `matchedProducts`); take **targeted action** on the specific failing span (never blanket-replace — the `fcd0af7e` pathology); **single explicit fail policy** — on catalog-lookup infra error, escalate with a distinct retryable reason. Behind `GROUNDING_GATE_CONSOLIDATED`; supersedes P0-2/P0-3 once proven.

**Regression risk.** Medium, mostly safe direction (widening to the full catalog can only stop false escalations). New-risk surface: (a) **format non-compliance** — the model asserts a fact in prose not in `facts_used` (mitigated by the deterministic prose backstop + a reconciliation check treating prose-only unverifiable facts as strippable); (b) **fact-extraction under/over-reach**. Determinism ≠ correctness — a bug in the fact index now fails identically every time, so tests assert correctness, not just stability.

**Migration path.** (1) Ship on top of P1's materialized fact index (fallback: P0-2's cached-query set). (2) Introduce the `facts_used` schema in **shadow** (emit + log declared facts, guards stay live) for one window — confirm schema-compliance. (3) Turn on the gate for **price** first (pure fn), then **name**, then **attribute/answered-fully** (retires the gap assessor); each a sub-flag. (4) Delete legacy guards, flip P0-2/P0-3 off. (5) Staging → prod per dimension.

**Rollback.** Per-dimension sub-flags revert to the P0-2/P0-3 interim guards. The `facts_used` schema can run in shadow indefinitely with zero behavioural effect.

**Validation.** **Acceptance:** replay EV-011/013/015 → zero flags. **Determinism:** replay IN1/IN3 + the golden corpus N≥20× → identical verdict, escalation rate below threshold, **zero product-claim tokens absent from the injected FACTS block** (deterministic token-membership, not an LLM judge). Property test: any active-catalog price/name never flags regardless of `matchedProducts`. Negative: a genuinely fabricated price/name still flags. Schema-compliance metric from the shadow window.

**Testing.** Unit: the gate as a pure function `(facts_used, prose, catalogFactIndex) → verdict`; the EV corpora as permanent fixtures. Unit: schema-parse + prose-backstop reconciliation. Integration: generation→gate with `matchedProducts=[]` + populated catalog. Regression: the `fcd0af7e` transcript asserts the two real products are sent, not replaced.

**Edge cases.** Soft-delete timeline (the "Mass Gainer Pro" lesson) — for a live reply the current active index is correct; a stale index after a price edit is bounded by synchronous index update + reconcile cron. Multi-currency tolerance. Discounted + base both in the index. `usedFullCatalogFallback` empties `matchedProducts` — the gate is decoupled from `matchedProducts.length`. Free-form info — a bounded LLM residue under an explicit fail policy. `finish_reason==='length'` at `max_tokens:768` can drop `facts_used` — treat as a retryable generation failure.

---

### P2-2 — Classifier consolidation: collapse ~30 LLM call-sites to ~4 roles (full Phase 6 sweep)
- **RCs addressed:** RC-07 (Medium), RC-08 (Medium), RC-22 (Medium), RC-10 (Medium)
- **Depends on:** P2-1, P0-4, P0-6

**Strategy.** Phase 6 dispositioned 39 tools as Keep 14 / Merge 11 / Redesign 9 / Replace 3 / Split 1 / Remove 1. P2-2 executes the *complete* sweep so the 18–25 (worst-case ~70) serialized stochastic calls collapse to the four legitimate roles: one prose generation, one structured slot-extraction, one ambiguity-only sensitive-intent classifier, offline eval. **Order/consent cluster → persisted `order_stage` machine + normalized consent lexicon:** replace `classifyNewOrderSignal`, `detectOrderAffirmationIntent` (each run twice/job, C-127), `hasAssistantAskedOrderClosingInConversation` (an LLM call *inside a for-loop over 40-message history*, ~40 calls, C-126), the 7-conjunct draft-order gate (`:3605-3612`), and the data-confirmation cascade with slot-completeness (E.164 + non-empty address) + a consent lexicon (`po`, `ok`, `dakord`, `e du`, Gheg forms). **No confidence field to boost or omit** → RC-07's asymmetry and RC-22's 7-conjunct flip both vanish. Commission from **stored ordered timestamps**, not the `NOW()`-relative post-send window. **Usage cluster (Merge 3) → single classifier + deterministic post-validation.** **Structured-output contract:** migrate every survivor to `json_schema` with `confidence` required + declared range (eliminates the `>1 ? /100` scale-guess, T2). **Replace 3 → lexical-first.** **Split 1 / Remove 1** (delete dead `isProductKnowledgeQuestionUnanswered`, `aiService.ts:2434`). **Language (RC-10) → sticky slot:** persist the resolved locale; the hard `'sq'` default (`aiService.ts:1837`) is reached only when genuinely unknown. Per-class flags each with a golden-set determinism test.

**Regression risk.** Medium — the largest behaviour-surface change in P2. Mitigations: per-class flag + shadow window comparing new deterministic vs old classifier verdict on live traffic before cutover; the deterministic-lexicon coverage gap is the real new risk (a Gheg form absent from the lexicon is a silent routing miss) — mitigated by P2-4's ledger surfacing fall-throughs and P2-5's Gheg curation. Re-express duplicate-order/data-confirmation guards as stage transitions, not dropped.

**Migration path.** (1) Shared `json_schema` parse/validate helper + required-`confidence` contract first (additive). (2) `order_stage` machine reading P1's slot store, in shadow, logging new-vs-old for one window. (3) Cut over order cluster → usage merge → lexical-first → sticky locale, each flagged and gated on a golden test. (4) Remove dead code only after a full billing period of production shadow parity.

**Rollback.** Each class flag reverts to the legacy classifier; the shared schema helper is safe to leave on. No data migration (`order_stage` is a P1 slot).

**Validation.** Boundary corpus near each retired threshold (0.75/0.8/0.85, the `>0.7` knife-edge) replayed N× → deterministic label, no flips. Order determinism: identical order-ready transcripts (EV-025-style) → same order + commissionability across runs/workers. Shadow parity report per class. Call-count assertion: fan-out drops from 18–25 to ≤~4 (P2-4 ledger).

**Testing.** Unit: the `order_stage` transition table + consent lexicon (pure fns); the shared schema parser. Integration: full order flow across {slots complete/incomplete × consent present/absent × Gheg}. Regression: I1/I2/I3/I8 scenarios as permanent fixtures.

**Edge cases.** Intent-detect throw (I8, `intentDetectionService.ts:153-155` swallowed at `:3831`) must **escalate/retry** (coordinated with P0-4). `explicitNewOrder=true` bypass (I3) re-expressed as a stage precondition, not preserved. Consent false positives (`po` in a complaint) — gate on `order_stage` being in a collecting/awaiting-confirmation state. Sticky locale must still allow a genuine mid-conversation switch (hysteresis). Vision turns discard `custom_model_id` (M1) — note for P2-7.

---

### P2-3 — Memory & history redesign: delivery-filtered transcript, deterministic-lossy-summary rebuild, versioned config cache
- **RCs addressed:** RC-16 (Medium), RC-17 (Medium), RC-13 (High — completion on top of P1 slot store)
- **Depends on:** P0-5

**Strategy.** P1 ships the persisted slot store closing RC-13's anchor loss (name/phone/address/`last_recommended_product_ids`/constraints always injected). P2-3 completes the three defects the slot store alone doesn't cover. **(1) Delivery-filtered transcript (RC-16):** `aiService.ts:3115-3118` maps *every* non-customer row to `assistant` regardless of `msg.flagged` or send status, re-feeding flagged-hallucination and never-delivered replies. Exclude `flagged=true` and non-delivered rows; map holding/escalation copy to `system` role. **(2) Deterministic-lossy-summary rebuild:** the customer-message-only summarizer (`:3049-3090`) discards every assistant turn (prices, recommendations, ETAs). Redesign to a **structured slot-backed summary** derived from the slot store + a bounded extractive pass over delivered assistant turns. **(3) Versioned/CAS `ai_config` cache (RC-17):** `ai_config:{tenantId}` cached `EX 900` with delete-only invalidation carrying `custom_model_id` (`:228/4108`); the toggle path never invalidates (`chatbotControlController.ts:31/55`); the refill-resurrection race re-SETs stale after DEL (`:203`). Key by a **config-version hash** (bump on every write incl. toggle), use CAS/versioned keys. Behind `HISTORY_DELIVERY_FILTERED`, `SUMMARY_SLOT_BACKED`, `AI_CONFIG_VERSIONED_CACHE`.

**Regression risk.** Low-to-medium. (1) is strictly corrective; risk is excluding a legitimately-delivered reply if the delivery field is unreliable — key exclusion on P1's explicit `delivered` marker. (2) validate the slot-backed summary carries a strict superset of load-bearing fields. (3) ship the version bump on writes before readers switch to versioned keys.

**Migration path.** (1) Add `delivered`/`flagged` filtering (reads P1's `sent` marker or existing send-status). Ship first. (2) Config-version column + bump on all mutation paths — writers first, readers second, then remove delete-only invalidation. (3) Rebuild the summarizer slot-backed in shadow, then cut over.

**Rollback.** Each flag reverts independently. History reverts to the `sent_by!=='customer' → assistant` mapping. Config-version reverts to `EX 900` delete-only. Summarizer reverts to customer-message-only.

**Validation.** RC-16: a reply flagged on turn N absent from the turn N+1 prompt; a send-failed row absent; a holding message appears as `system`. RC-13/summary: a 50+-turn conversation never re-asks a provided field and never denies a previously-recommended in-stock product. RC-17: edit `tone`/`custom_model_id` → the next reply on all workers reflects it within one request; the toggle path bumps the version (regression for C-55). Resurrection-race test.

**Testing.** Unit: history-assembly filter predicate; the slot-backed summary projector; the config-version bump. Integration: multi-worker config-edit propagation; the 50-turn depth scenario. Regression: "correct-early then flagged-hallucination then depth."

**Edge cases.** Legacy rows without a reliable delivery marker — treat as delivered unless explicitly flagged. A reply flagged **and** corrected/sent — the delivered corrected text is history, the flagged draft is not (P2-4 ledger persists both). `custom_model_id` must invalidate on fine-tune completion too. Summary token budget interacts with the unbudgeted prompt (RC-26, P2-5).

---

### P2-4 — Hybrid substrate completion: append-only decision ledger + receipt-time snapshot + dedupe replay protection + `facts_used` persistence
- **RCs addressed:** RC-06 (Medium), RC-11 (Medium), RC-17 (Medium), RC-20 (High), RC-21 (High)
- **Depends on:** P0-6, P0-7, P2-1

**Strategy.** P1 ships the minimal outbox + idempotency closing RC-20/21 atomicity. P2-4 completes Phase 12's B-Phases-1-3 substrate — the observability + receipt-time-determinism layer riding inside P1's outbox txn. **(1) Append-only per-turn `decision_ledger`** (`tenant_id`-scoped, same txn as the reply): prompt provenance (hash + pointer — closes OBS-1/C-107; makes the orphan `offers_promotions` a query, RC-26); model & params per call (incl. `custom_model_id`-vs-base, temp, seed, max_tokens, `finish_reason` — RC-03/RC-17/C-97); token usage & cost (`completion.usage`, OBS-2/C-108); retrieval quality (scores, threshold outcome, `semanticSkipped`); decision capture (each classifier's raw score, threshold, boost-applied flag — RC-07 — branch taken; the gate's reference set + per-span verdict); a **fail-closed-vs-genuine flag** on every `ai_alerts` row; a single **correlation id** threaded from webhook + HTTP receipt into `aiService` and every call (today 0 refs, C-109) at per-message granularity. **(2) Receipt-time snapshot (RC-06/RC-17):** at receipt capture `tenantId`, resolved `channelId`, the three enablement gates, the ai_config version hash (P2-3), and locale into the job payload; the worker evaluates against the snapshot, not re-read ≥8s later. **(3) Dedupe replay protection (RC-11):** drop the `Date.now()` freshness gate (`webhookController.ts:303-304`, `viberWebhookController.ts:168`) that auto-passes timestamp-less payloads and 403s late-but-valid deliveries forever; accept late-but-valid deliveries + de-dupe on the idempotency key (P1). **(4) Structured logging + Sentry on the AI path** (277 `console.*` sites) keyed by the correlation id; **redact PII at the boundary** (C-113/OBS-7); route errors to Sentry (0 today, C-110); wire a log aggregator. Behind `DECISION_LEDGER`, `RECEIPT_TIME_SNAPSHOT`, `WEBHOOK_DEDUPE_REPLAY`, `STRUCTURED_LOGGING`.

**Regression risk.** Low for ledger/logging (additive, write-side; bounded by writing async-but-in-txn + sampling). Medium for the receipt-time snapshot: it changes *when* state is read — a fast legitimate toggle-off between receipt and run now still processes the message under the snapshot (acceptable and correct — the whole point of RC-06). The dedupe change accepts a late delivery the skew-gate dropped (intended; the idempotency key prevents double-processing).

**Migration path.** (1) Ledger table + correlation-id threading + `usage`/score capture, write-only, in shadow — pure observability, ship first (the measurement instrument for every other P2 item). (2) Structured logging + PII redaction + Sentry-in-jobs. (3) Receipt-time snapshot; switch gate evaluation to the snapshot behind its flag (requires P2-3's config-version). (4) Dedupe replay (requires P1's idempotency key); remove the skew-403.

**Rollback.** Ledger/logging additive — disabling stops writes. Snapshot reverts to run-time reads. Dedupe reverts to the skew-403 gate.

**Validation.** **Reconstruction (Phase 15 §15.2):** replay `fcd0af7e` → recover the prompt, model/params, retrieval scores, `semanticSkipped`, classifier chain, and fail-closed flag **from the ledger alone**. RC-06: toggle AI off between a message's receipt and its run → processed under the receipt snapshot; the ledger records it. RC-11: a 6-min-late valid delivery enqueued exactly once; a timestamp-less replay deduped. PII: grep the log stream for a seeded phone → zero cleartext. Cost: per-conversation aggregates sum to the OpenAI dashboard within tolerance.

**Testing.** Unit (ledger writer append-only/tenant-scoped/txn-bound; redaction boundary; snapshot serializer). Integration (snapshot evaluation across toggle/hold/human-reply timing; dedupe across missing-timestamp/late/duplicate). Regression: the `fcd0af7e` reconstruction as a permanent test.

**Edge cases.** A ledger insert throwing inside the outbox txn — fail the whole txn only if same-txn; if async, never block send (send-critical markers in-txn, verbose telemetry best-effort). Prompt blobs (26–33K chars) — hash + dedup or object-storage pointer. Correlation-id per-message vs per-webhook (burst-merge). Retention/sampling + GDPR. Snapshot staleness within its window is acceptable — do not refresh mid-job.

---

### P2-5 — Albanian/Gheg capability program + prompt-assembly hygiene
- **RCs addressed:** RC-25 (Medium), RC-26 (Medium), RC-10 (Medium), RC-15 (fluency portion)
- **Depends on:** P2-1, P2-2

**Strategy.** WF-E scored Albanian **54/100** in the core Kosovo/Gheg market. Six workstreams. **(1) Consistent dialect normalization (RC-25):** embedding input is NOT normalized while lexical paths strip diacritics (a `%shije%` substring matches ~18% of a tenant's catalog) — the arms disagree. Apply one diacritic-fold + Gheg-normalization to all three surfaces (embedding query, lexical keys, the P1/P2-1 fact index). **(2) Gheg-aware routing lexicons (RC-25, RC-10):** deictic lists omit `qito`/`kjo`/`qitynve`; cue regexes miss Kosovo forms (EV-010: "A keni ma shum a veq aito" slipped every regex; "ma shum" escalated as a missing attribute). Extend the P2-2 lexicons with curated Gheg forms; P2-4's ledger surfaces uncovered fall-throughs as the curation loop. **(3) Multilingual retrieval:** with (1), re-evaluate the `-small`/0.65 choice (EV-043) with the P2-1 gate as the safety net. **(4) Business-rule footer to all tenants (RC-25/RC-26):** the restrictions footer reaches **1 of 6 tenants**; `platform_restrictions` is never rendered (`buildRestrictionsFooter`). Fix the render path; reconcile R6/R13/R16/R17. **(5) Prompt hygiene (RC-26):** remove the orphan admin-created `offers_promotions` block (absent from migrations, catalog-inactive, ~1478 chars referencing a nonexistent "Active offers" section, 6/6 tenants) via a render-time allowlist; token-budget the system prompt (26–33K chars, unbudgeted); required-section assertion. **(6) Offline Gheg fluency eval (RC-15 fluency portion)** — narrow, recalibrated, off the send path (Phase 12 role 4). Behind `DIALECT_NORMALIZATION`, `GHEG_LEXICONS`, `PROMPT_ALLOWLIST_BUDGET`, `RESTRICTIONS_FOOTER_ALL_TENANTS`.

**Regression risk.** Low-to-medium. Normalization (1) must not *merge* genuinely distinct products (structured columns stay authoritative). Footer/allowlist (4/5) change every tenant's prompt — validate the footer addition doesn't exceed budget and orphan removal removes no relied-upon content (it references a nonexistent section, so it cannot). Lexicon additions (2) can only catch more Gheg; risk is a false consent/cancel match, gated by `order_stage`.

**Migration path.** (1) Ship the shared normalization + apply to embedding + lexical + fact index in lockstep; re-embed under normalization (reconcile cron). (2) Prompt allowlist + budget + orphan removal (config/render, no data migration). (3) Restrictions footer to all tenants; reconcile R6/R13/R16/R17 with the P2-1 gate. (4) Gheg lexicon extension; wire the ledger fall-through report. (5) Offline fluency eval as CI/nightly, never on send.

**Rollback.** Each flag reverts independently. Normalization revert requires re-embedding under the old normalization — gate behind a reconcile job; keep old vectors until validated. Footer/allowlist revert is a render-path revert. Lexicon entries are removable data.

**Validation.** EV-010 regression: "A keni ma shum a veq aito" routed correctly (not escalated as `["ma shum"]`). Normalization consistency: the embedding and lexical arms agree on the matched product. Footer coverage: all 6 tenants render the footer; `platform_restrictions` non-empty in every prompt. Prompt budget: assembled prompt ≤ budget for every tenant; the orphan block appears in zero prompts. Albanian re-score materially above 54/100.

**Testing.** Unit: the normalization fn (Kosovo fixtures); the render-time allowlist; the footer builder for all tenants. Integration: retrieval agreement across normalized Gheg queries; prompt assembly asserts allowlist + budget + footer. Eval: WF-E corpus + EV-010 as permanent fixtures; offline fluency nightly (P0-1 CI).

**Edge cases.** Over-folding: two products distinguishable only by a diacritic must stay distinct (product id + structured columns authoritative). Mixed-language messages. Re-embedding cost at scale (stagger per tenant, keep old vectors live). `SHARED_CONTENT_SYSTEM_APPEND` is Albanian-only regardless of locale (DP-pc-18) — reconcile with sticky-locale. The offline eval must never re-enter the send path (an architectural test forbids importing it there).

---

### P2-6 — Circuit breakers, graceful degradation, and provider-failure isolation
- **RCs addressed:** RC-19 (High — completion beyond P0-4), RC-04 (High/reliability)
- **Depends on:** P0-4, P2-2, P2-4

**Strategy.** SPOF-3 (Phase 14): a single OpenAI provider, no fallback, no breaker, degrading *incoherently* — the umbrella fail-open (RC-19) turns a refund demand into a sales reply while the fail-closed gap gate escalates every product question, across a fan-out where each call inherits `60s × (1+3 retries) ≈ 240s` with no per-call abort (`openaiClient.ts:15-29`). P0-4 made the *sensitive* path fail-closed; P2-6 gives the *whole* pipeline a coherent posture. **(1) Per-call abort + shared per-turn deadline:** an `AbortSignal` with a role timeout on every call (only `detectSpecifiedAttributes` has one, 6s); a single per-turn deadline so a slow provider window fast-fails instead of holding a slot + lock for minutes. **(2) Circuit breaker on the OpenAI client:** open after N consecutive failures → fast-fail for a cooldown; half-open probes restore; record transitions in the P2-4 ledger. **(3) Defined graceful-degradation mode:** one safe floor — templated holding reply + escalate with a retryable distinct reason. **(4) Retrieval reliability (RC-04):** aborting timeout + negative caching + `semanticSkipped` metric (blast radius already removed by P2-1's full-catalog gate). **(5) DLQ + exhaustion alerting** (fix `failureHandler` misclassifying stall-killed jobs, C-88; route to Sentry). Behind `OPENAI_CIRCUIT_BREAKER`, `PER_TURN_DEADLINE`, `GRACEFUL_DEGRADE_MODE`, `EMBEDDING_ABORT_CACHE`, `AI_DLQ_ALERTING`.

**Regression risk.** Medium. A breaker/deadline can cut off a slow-but-successful call — the trade is bounded worst-case latency (fast-fail to holding) vs. minutes-long lock-holding stalls; tune conservatively against real p99. Graceful-degradation will *escalate more during an outage* (correct — those turns can't be answered). The aborting embedding timeout must actually cancel the HTTP request (verify no socket leak).

**Migration path.** (1) Per-call `AbortSignal` + role timeouts + aborting embedding timeout + negative cache first. (2) Breaker in **monitor-only** mode (count would-open events) for one window; then enable fast-fail. (3) Wire graceful-degradation behind its flag; validate via fault injection. (4) DLQ + exhaustion alerting + Sentry (depends on P2-4).

**Rollback.** Each flag reverts. Breaker → monitor-only → off. Deadline → inherited SDK timeout. Graceful-degrade → prior per-catch behaviour. Embedding abort → non-aborting race. Only additive schema is the DLQ table.

**Validation.** Provider outage: stub all calls to time out → every turn resolves to the templated holding+escalate floor (no wrong-class reply, no silent drop, no 240s hang), a retryable alert fires, the ledger records the breaker state. Breaker: N consecutive failures → opens → fast-fail within cooldown → half-open restores. Deadline: a call exceeding the budget aborts and releases the lock + slot promptly. Embedding: timeout aborts the HTTP request (no leaked socket), negative-caches, increments `semanticSkipped`. DLQ: an exhausted job lands in the DLQ + alerts; a stall-killed job is terminal.

**Testing.** Unit: the breaker state machine (closed/open/half-open); per-turn deadline accounting; the aborting-timeout wrapper. Integration: full-/partial-outage injection; DLQ routing. Regression: "refund demand during an OpenAI blip" asserts holding+escalate+retry, never a sales reply — completes P0-4 fleet-wide.

**Edge cases.** A refund message during an open breaker must still escalate (the graceful-degrade floor is escalate — composes correctly). The deadline must not abort mid-send (scope to pre-send). Breaker false-open on a brief spike (half-open + conservative threshold + monitor-only bake-in). Lexical-only fusion is the correct degraded retrieval. DLQ growth in the 192MB noeviction Redis needs a retention/trim policy.

---

### P2-7 — Config-drift hardening: boot-time validation, dimension/threshold/seed guards, per-role model config
- **RCs addressed:** RC-15 (Medium — threshold drift), RC-04 (embedding-dimension landmine), RC-06 (module-load knob drift), RC-17 (model-config drift). Also touches RC-03 (config side).
- **Depends on:** P0-1, P2-4

**Strategy.** The audit found standing environmental divergence — the same input produces different outcomes across workers/deploys purely by config provenance. Extend `config/validateEnv.ts` from a 4-var presence check into a **typed config module with boot-time assertions**. Seven guards: **(1) Embedding-dimension (RC-04, M3):** code/CLAUDE default `-large` (3072) while `.env.example` ships `-small` (1536), no `dimensions` param (`embeddingService.ts:12-15`), column `vector(1536)`. Assert the resolved model's native dimension equals the column, or pin `dimensions:1536`. **(2) QUALITY_THRESHOLD (RC-15, M2):** code `0.1` vs `.env.example` `0.6` — a 6× floor deciding whether the systematic `0.200` order-confirmation false-low pauses *at checkout*. Reconcile; better, **remove the quality eval from the send path** (factual role → P2-1 gate, fluency → offline P2-5). **(3) Seed/temperature band (RC-03, M6):** no `seed`/`top_p` exists; reply runs at `AI_REPLY_TEMPERATURE=0.3`. Pin/expose a `seed`; assert both within an approved band; correct the overstated determinism comments (`aiService.ts:115-120`). **(4) Per-role classifier model vars (M5/T7):** only 2 of ~30 honor a dedicated var; the other ~28 ride `OPENAI_CHAT_MODEL`. After P2-2 (~4 classifiers) give each its own var. **(5) Single model-resolution chain (M8):** collapse the three divergent chains; fail fast on a typo'd required model var. **(6) INTENT_THRESHOLD + undocumented-knob validation (I6, RC-06):** accepted only when `>0 && <1` else silently `0.85` with no log, absent from `.env.example`. Validate + log the effective value of every knob; add all undocumented knobs. **(7) Cross-instance env-drift assertion (RC-06):** emit module-load-frozen knobs into the P2-4 ledger/startup log so a drifted multi-instance deploy is detectable. Behind `STRICT_CONFIG_VALIDATION`.

**Regression risk.** Low, sharp edge: a strict assertion **will refuse to start** a mis-set deploy — intended, but can turn a silently-degraded "working" deploy into a hard boot failure. Mitigate with **warn-only** mode first, confirm the fleet is clean, then flip to fail-fast. The `dimensions`-pin changes the embedding call — validate it produces 1536-dim vectors identical to current `-small` output.

**Migration path.** (1) Extend `validateEnv.ts` with all seven assertions in **warn-only** mode; observe the WF-G drift table clear in staging. (2) Reconcile the drifted values (QUALITY_THRESHOLD, embedding model, chat model, INTENT_THRESHOLD in `.env.example`). (3) Flip to fail-fast in CI/pre-deploy (not runtime boot of a running prod — mirror P0-1). (4) Per-role model vars + single resolver alongside P2-2. (5) Wire the cross-instance drift emission into P2-4.

**Rollback.** Flag off restores permissive `validateEnv`. Warn-only is safe to leave on. `dimensions` param and per-role vars are additive with safe defaults.

**Validation.** Dimension guard: `-large` with no `dimensions` → boot fails naming 3072-vs-1536; with the pin → boots and writes valid vectors. Threshold: a QUALITY_THRESHOLD outside the band → warn/fail; the order-confirmation pause-at-checkout no longer fires once the eval leaves the send path. Drift: two instances with different `AI_MAX_REPLIES_PER_HOUR`/`INTENT_THRESHOLD` → surfaced. Resolver: a typo'd `OPENAI_CHAT_MODEL` → fail-fast, not a silent fall to `'gpt-4o'`. CI: a PR reintroducing a drift → red.

**Testing.** Unit: each assertion as a pure function over a synthetic env. Integration: boot with a matrix of mis-set envs (warn-vs-fail per mode). Regression: the WF-G config-drift table as a fixture.

**Edge cases.** Warn-only must distinguish "required and missing" (fail) from "optional, using default" (info-log). The dimension guard reads the actual column dimension from `information_schema` (single source). Removing the quality eval must be coordinated with P2-1/P2-5 so no signal is lost. Per-role vars must not reintroduce M1 (vision dropping `custom_model_id`). Keep the hard fail in CI/pre-deploy; warn-loud-but-start at runtime boot for pre-existing drift.

---

## P3 — BACKLOG / STRATEGIC

### P3-1 — Complete the Phase 12 hybrid: deterministic routing collapse + single grounded generation with a `facts_used` contract + one consolidated full-catalog grounding gate + persisted slot store + resumable FSM
- **RCs addressed:** RC-01, RC-02, RC-03, RC-05, RC-06, RC-07, RC-08, RC-10, RC-13, RC-14, RC-16, RC-22
- **Depends on:** P0-2, P0-3, P0-4, P0-5, P1-1, P1-3, P1-5, P3-4

**Strategy.** The umbrella program turning the P0/P1/P2 stop-gaps into the permanent architecture. Today the hot path is a ~4,000-line orchestrator wrapping ~18–25 serialized stochastic calls around one unconstrained generation (temp 0.3, no seed, no `response_format`). The end-state collapses that to **1–2 completions/message** governed by deterministic state and one gate. Five moves: **(1) Deterministic routing collapse** — escalate-or-answer → catalog attribute-presence SQL (RC-01); price/name/availability → PK + `pg_trgm` lookup against the full active catalog (RC-02, supersedes P0-2 with the materialized index); order-field completeness & affirmation → persisted `order_stage` FSM + E.164 + non-empty-address + Gheg/sq consent lexicon (RC-07, RC-08, RC-22); reply language → channel/contact-locale sticky slot (RC-10). Residual LLM surface = four bounded roles. **(2) Single grounded generation with a `facts_used`/`cited_products` contract (RC-03, RC-02)** at temp 0 + fixed seed + `response_format`, verified by PK lookup against the full active catalog *before send*. **(3) One consolidated grounding gate (RC-01, RC-02)** — a pure function of `(cited_products, fullActiveCatalog)`; RC-01's 8/8 fail-closed class is *eliminated* (bounded stochastic residue remains — no total-elimination claim). **(4) Persisted slot store + delivery-filtered history + serialized per-conversation processing (RC-13, RC-16, RC-05)** — always-injected slots, id-lookup re-grounding at any depth, FIFO-by-timestamp removes the burst race structurally. **(5) Resumable FSM + receipt-time decision snapshot (RC-14, RC-06, RC-22)** — every non-terminal state declares a non-human exit; sensitive escalations still exit only via alert resolution (preserves P0-5 policy); commission is a deterministic fold over stored ordered timestamps, never `NOW()`-relative.

**Regression risk.** High — the largest behavioural surface in the program, touching every outcome class and billing. Risks: (a) the `facts_used` contract is the crux — weak Gheg free-text→slot extraction degrades grounding against a *better* reference set; (b) determinism ≠ correctness (a wrong lexicon/slot rule now fails identically every time); (c) retiring 20+ classifiers risks dropping a useful long-tail behaviour; (d) FSM cutover can strand in-flight conversations. Mitigated by per-decision flags, shadow-mode diffing (P3-4) of every retired classifier before cutover, and the golden/EV replay corpora as hard gates.

**✅ RESOLVED (contradiction half) — declared ATTRIBUTE facts are now consumed.** *Was:* the `facts_used` contract instructed the model to declare attribute claims (`{type:'attribute', product_ref, value}`), but `evaluateConsolidatedGrounding` consumed **only** `f.type === 'name'` and dropped the rest — a live, unguarded fabrication class, **a false SENTENCE built from true WORDS**.

`evaluateConsolidatedGrounding` now consumes `f.type === 'attribute'` behind `GROUNDING_GATE_ATTRIBUTE_FACTS` (`off | shadow | enforce`, default `off`), resolving each fact's `product_ref` to one active row and taking the same targeted sentence strip the name path takes. The P3-4 tripwire fired on landing and was deleted; the invariant is now guarded in **both** directions by an inverse source assertion in `services/__tests__/groundingGateAttributeLane.test.ts`.

**The implementation deviates from the wording above, on evidence.** "Validate against the injected catalog, flag what is absent" is not safely implementable on this data. Measured on the only real catalog (tenant `02beb134`, 257 active rows): `flavor` and `brand` are non-null on **1** row each, `size`/`color`/`variant`/`weight` on **zero** — the structured columns are empty — and **218 of 257** rows say nothing about sugar, while most supplements genuinely *are* sugar-free (the merchant simply never wrote it down). Flagging silence would strip **true** sentences at scale into a pause that has no automatic exit. The lane therefore flags **contradiction only**: the resolved row's own text must assert the opposite.

That still closes the example above, because the example was mis-described. `Mega mass 3kg Vanil` exists and its description reads *"**Sheqer i reduktuar:** … është **më e ulët në sheqer**"* — the catalog is not silent on sugar, it says *reduced*. "pa sheqer" is **refuted**, not merely unsupported.

**Still open, deliberately:** (a) the **silence** half — closing it needs merchant-supplied structured dietary data, not a cleverer text predicate; (b) **undeclared** attribute claims — the lane consumes declarations only, and unlike prices there is no deterministic prose backstop for a semantic claim, so `shadow` records the declared-fact count per turn to make a dead guard distinguishable from a clean one; (c) substances outside the closed lexicon. Do not read this as "attribute fabrication is solved".

**Migration path.** Phase 12 migration steps 4–5, gated on 0–3 (the P0/P1/P2 substrate). (1) Land the **materialized full-catalog fact index**; acceptance = zero flags on EV-011/013/015. (2) Introduce the `facts_used`/`cited_products` generation in **shadow** — diff cited facts against the catalog, don't send until clean; **extend the gate to validate declared `attribute` facts, not just `name` (see the open gap above)**. (3) Collapse guards into the one gate one family at a time (price→name→gap→usage→deflection), each diffed in shadow. (4) Cut over deterministic routing per class (language first; then availability/attribute; then order-stage/affirmation; then escalate-or-answer last). (5) Promote the slot store to the versioned end-state + delivery-filtered + serialized processing. (6) Promote the pause lifecycle to the full FSM + per-reason resume + receipt-time snapshots + deterministic commission fold. Each cutover: shadow-diff clean → staging → 1-week canary → platform flag-on.

**Rollback.** Every sub-step is a flag over the legacy path, retired only after clean shadow + canary. Slot store and FSM tables additive/nullable; the legacy four-column pause state is dual-written until the FSM is proven. No destructive migration until a decision has been flag-on in production for a full billing period without a golden-set regression.

**Validation.** **Determinism (primary gate):** the RC-01 golden set N≥20× → identical non-escalating decision; EV-011/013/015 → zero flags; IN1/IN3 stop escalating 8/8. `facts_used` property test: every cited price/name/**attribute** present in the injected catalog facts; any citation absent from the full active catalog caught pre-send. **Explicit acceptance for the attribute gap:** a reply asserting an attribute the catalog does not carry ("… është pa sheqer" against a row with no sugar field) is stripped or escalated, and `eval/harness/__tests__/tokenMembership.test.ts`'s `facts_used`-coverage assertion goes red — that red is the signal to delete it and the KNOWN RECALL GAPS note it guards. Fan-out: completions/message drops from 18–25 to ≤2. Issue-2 depth: a 50+-turn conversation never re-asks a slot / never denies a recommended in-stock product. Billing reproducibility: identical order-ready transcripts → identical order + commissionability across N runs. The 548-suite + the standing eval harness (P3-4) green on every cutover PR.

**Testing.** Unit: pure `decide(state, event, policy)` transitions; the gate as a pure function of `(cited_products, catalog)`; each deterministic replacement. Integration: full pipeline per cutover flag. Regression: every retired classifier gets a shadow-diff fixture; EV/golden corpora permanent. Eval: LLM-as-judge fluency only on the residual prose (P3-4), never on decisions.

**Edge cases.** Gheg free-text parse into slots stays irreducibly semantic — the *decision* becomes SQL, the *parse* is the one extraction call (NLU does not disappear). `facts_used` under-declaration — inject facts before generation + a shadow false-negative monitor. Soft-deleted-but-historically-real products — the live gate validates against the current active catalog. FSM mid-migration — dual-write legacy pause columns + FSM state. Sensitive-intent residue keeps its own fail-closed catch (RC-19 interaction). Empty/rotated retrieval window is irrelevant to correctness — assert the gate ignores window membership entirely.

---

### P3-2 — Horizontal scalability: out-of-process worker fleet, per-tenant isolation & fair backpressure, per-tenant HNSW partitioning, role-split pools
- **RCs addressed:** RC-18, RC-05, RC-04, RC-20
- **Depends on:** P0-1, P0-6, P1-1, P1-2

**Strategy.** The binding constraint is the single-instance, single-process topology. `server.ts:1-24` starts all five BullMQ workers *in the same process as Express + Socket.IO*; `docker-compose.prod.yml:61-78` runs one `backend` container with `AI_WORKER_CONCURRENCY:2`, `max_connections=80`, one 192MB noeviction Redis → **~2 concurrent AI replies platform-wide**. **(1) Split workers into their own deployable (SPOF-1, RC-20 deploy variant):** extract the bootstrap into `worker.ts` + a separate replica set. Fixes the deploy-injected non-idempotency: `SHUTDOWN_TIMEOUT_MS=25000` > Docker 10s grace with no `stop_grace_period` (`server.ts:41`) SIGKILLs in-flight jobs mid-send. Add `stop_grace_period: 30s` + pair with P1-1's idempotent outbox. **(2) Right-size per-tenant fairness + backpressure (RC-18, RC-05):** the per-tenant cap `AI_MAX_CONCURRENT_PER_TENANT=8` is inert below the system-wide 2 and, when it engages, busy-loops re-adding fresh delayed jobs every ~3s (C-79) — a retry amplifier that burns the 25/h budget. Replace with BullMQ group/priority queueing + depth-based admission control; supersedes P0-6 by removing the phantom-job population at the source. **(3) Per-tenant vector partitioning (RC-04, C-132):** the global HNSW with a tenant post-filter crowds a small tenant's matches out as the platform grows (mitigated only by an adaptive `ef_search 100→500` firing on nearly every small-tenant query, C-125). Move to per-tenant partial/partitioned indexes so recall is a function of a tenant's own catalog size. Guard the dimension landmine (`-large`=3072 vs `vector(1536)`). **(4) Role-split pools + Redis capacity plan (SPOF 2/4):** split `db/pool.ts` into API + worker pools; raise `max_connections` + read replica; keyspace-separate the queue Redis from cache Redis.

**Regression risk.** Medium-high, infrastructure-wide. Splitting the process changes the deploy unit and failure domains (a worker outage no longer takes the API down — a gain — but config/env skew is a risk). Group/priority queueing changes ordering/latency under load. Per-tenant partitioning is a schema/index change that must preserve query plans + cross-tenant isolation (0 leakage in dev, EV-038, must hold). All dormant at dev scale — validation depends on synthetic load tests, labelled accordingly.

**Migration path.** (1) Extract `worker.ts`; run alongside in-process workers behind a flag to prove parity, then remove the in-process start + scale to N replicas + `stop_grace_period` + P1-1 idempotency. (2) Replace self-reschedule with group/priority queueing in shadow. (3) Admission control + shedding (needs P1-2/P3-6 metrics). (4) Prototype per-tenant partitioning on a synthetic 10⁵–10⁶-product catalog; validate recall + plan stability; migrate behind a flag with a reindex plan. (5) Role-split pools + read replica + Redis capacity plan last, under load test.

**Rollback.** Worker-split reversible (re-enable in-process start). Queueing flagged. Vector partitioning least-reversible (ship last, retain the global index until proven). Pool split config-only.

**Validation.** **Load test (dev cannot show this):** a noisy tenant burst must not starve others; bounded p99 under 10²–10³ concurrent tenants; queue depth sheds gracefully. Deploy safety: a rolling deploy under load drops **zero** in-flight `ai.reply` jobs (drain + idempotent resume). Retrieval recall at scale: a small tenant's true matches stay in-candidate-set on the synthetic catalog (C-132 acceptance). Isolation invariant: 0 cross-tenant rows (preserves EV-038). Budget determinism: N retries → one budget unit (RC-18, now structural).

**Testing.** Unit: fair-share scheduler; admission predicate; pool router. Integration: worker-only deploy leaves API up; API-only deploy leaves the queue draining. Load/soak: multi-tenant burst harness as a standing scalability regression. Migration test: vector-partition reindex on seeded scale data.

**Edge cases.** Env skew across API vs worker containers reintroduces RC-06/RC-17 drift — boot-time assertion that all instances read identical frozen-at-load knobs. Socket.IO already uses the Redis adapter — confirm with multi-replica API. The 7 cron schedulers (incl. per-minute `offerEmbeddingReconcileFast` failing ~every run, EV-042) must run on exactly-one replica (leader election). Per-tenant partition explosion at high tenant counts — hash-partition into buckets. `noeviction` on the queue keyspace mandatory; eviction only on cache keyspaces.

---

### P3-3 — Migration runner → reversible, atomic, provenance-tracked framework (complete P0-1's stop-gap)
- **RCs addressed:** RC-23
- **Depends on:** P0-1

**Strategy.** `db/migrate.ts` is a hand-rolled runner: `readdirSync().sort()` **lexicographic** (`:19-22`), each file in its **own `BEGIN/COMMIT`** (`:37-46`, so a mid-sequence failure leaves the schema half-migrated with successful files committed), **no lock**, **no down migrations**, runs at deploy *and* every boot. Duplicate ordinals `062–065` each exist twice (EV-037) and `065_offers` applied a day before `063_catalog_grounding` (C-150). P0-1 added the two lowest-risk guards; P3-3 completes the framework: **(1) Cross-file atomicity option / recovery** — wrap a deploy's full pending set in one transaction where DDL permits, or record per-file checksums in `_migrations` + a documented recovery procedure; keep non-transactional DDL (`CREATE INDEX CONCURRENTLY`) explicitly out-of-transaction. **(2) Down/reversible migrations** — paired up/down (or recorded reverse SQL); moving prompt-block content out of migrations into the P3-5 registry removes the most dangerous irreversible class (19 prompt-mutating migrations, C-142 — the vector the orphan `offers_promotions` rode, RC-26). **(3) Resolve 062–065 + a robust ordering key** — consolidate/renumber into a monotonic sequence (or switch to a recorded `applied_seq` + timestamp); adopt timestamp naming for new files. **(4) Consider a proven framework** (node-pg-migrate / graphile-migrate / Sqitch) vs. hardening the bespoke runner; the "raw SQL, no ORM" house style favors a thin SQL-first tool.

**Regression risk.** Medium — migrations are load-bearing. Renumbering already-applied files risks mismatch with `_migrations.name` — reconcile carefully so a fresh DB and an existing DB converge. Down migrations are error-prone — prefer expand/contract + fix-forward for destructive changes; reserve true downs for reversible DDL.

**Migration path.** (1) Add checksum recording (additive column) + a CI dry-run applying all migrations to a scratch DB asserting monotonic order. (2) Move prompt-block content into the P3-5 registry. (3) Introduce down/reverse SQL for the reversible subset. (4) Reconcile 062–065 into a monotonic scheme + timestamp naming; reconcile `_migrations` via a one-time data migration. (5) (Optional) adopt the chosen framework, importing the reconciled history as baseline.

**Rollback.** Steps 1–3 additive. Step 4 ships with a tested forward + reverse path on a DB snapshot. Framework adoption gated behind a full staging rehearsal; the hardened bespoke runner remains the fallback.

**Validation.** CI dry-run applies the full set to a clean scratch DB **and** a restored production-shaped snapshot; asserts monotonic order and no duplicate-ordinal application. A deliberately-failing mid-sequence migration → the runner leaves a recoverable documented state (not a silent half-migrated schema); the advisory lock (P0-1) serialized concurrent boots. Round-trip: apply `up` then `down` on a snapshot → schema identical. A fresh DB and a pre-reconciliation DB both converge after the 062–065 reconciliation.

**Testing.** Unit: ordering-key parser; checksum comparator; duplicate detector. Integration: full apply on clean + snapshot DBs in CI. Migration test: up/down round-trips; the 062–065 reconciliation on a seeded legacy `_migrations`. Chaos: mid-sequence failure recovery.

**Edge cases.** `CREATE INDEX CONCURRENTLY` / `ALTER TYPE … ADD VALUE` can't run in a transaction — annotate and exclude. Existing `_migrations` uses filename as the key — reconciliation must not re-run or orphan applied files. Two boots racing — verify the lock holds across the framework migration. pgvector/pg_trgm extension migrations remain idempotent (`IF NOT EXISTS`). A migration that is *also* a prompt change (C-142) must be split.

---

### P3-4 — Standing AI eval / regression harness: golden determinism sets, EV-replay CI fixtures, offline quality/fluency evals, live-replay-repeat, shadow-mode diffing
- **RCs addressed:** RC-01, RC-02, RC-03, RC-15, RC-25, RC-23
- **Depends on:** P0-1, P0-2, P0-3, P1-5

**Strategy.** Phase 12/14 name this the hard dependency for *every* behaviour-changing cutover. The 548-suite is real but CI never runs it (RC-23, fixed by P0-1), and there is **no AI eval harness at all** — coverage is *inverted* (tested slice = deterministic leaf helpers; `processAIReply`, the guard pipeline, retrieval race, billing snapshot have **0 tests**, C-147). Build a first-class CI+offline system: **(1) Golden determinism corpora (RC-01, RC-03):** IN1/IN3 + answerable availability/attribute questions (Albanian+Gheg+English), each N≥20× with hard determinism assertions + a max-escalation-rate threshold; exact discrete-label checks, not LLM-as-judge. **(2) EV-replay corpora (RC-02):** EV-011/013/015 + the `fcd0af7e` transcript as fixtures asserting zero hallucination flags + (via P1-5) full reconstructability. **(3) Fabrication token-membership check (RC-03):** zero product-claim tokens absent from the injected catalog (catches the IN3 "BSN backronym" class). **(4) Move quality-eval OFFLINE (RC-15):** relocate the in-line eval (threshold 0.1 live vs 0.6 `.env.example`, systematic 0.200 false-low on confirmations, a degenerate "Po." clearing 0.1) into this harness — off the send path where its miscalibration can do no billing damage. **(5) Albanian/Gheg fluency scoring (RC-25):** a standing offline eval (WF-E 54/100 baseline); LLM-as-judge is appropriate here but only offline. **(6) Shadow-mode diffing + live-replay-repeat:** run a retired classifier and its deterministic replacement side by side on real traffic before cutover; the Phase 10 live-replay-repeat runner measuring `distinctRepliesPerInput`. Wire the fast deterministic assertions into CI (offline, ~6s); run LLM-judge evals nightly.

**Regression risk.** Low for the harness itself (additive), but it becomes a **release gate** — a flaky assertion blocks deploys, so the deterministic assertions must be genuinely deterministic (discrete labels, token membership) and the token-costing LLM-judge evals run offline/nightly, never blocking per-PR. Main hazard: false confidence — the harness only guards what it encodes; expand corpora as new failure classes surface.

**Migration path.** (1) Deterministic CI fixtures first (golden + EV replay + fabrication token check) — gate P0-2/P0-3, cost ~seconds, ride P0-1's CI step. (2) Build the live-replay-repeat runner (reuse Phase 10). (3) Shadow-mode diffing (needs P1-5's ledger). (4) Relocate quality-eval offline — run in parallel (log-only) to confirm scores match, then remove the in-line call. (5) Nightly LLM-judge fluency/Gheg evals with trend dashboards.

**Rollback.** Additive test infrastructure — disabling an assertion is a config change. Quality-eval relocation is flag-gated (keep the in-line call behind a flag until the offline replacement is trusted).

**Validation.** The harness must **reproduce the audit's findings**: run against the pre-fix codebase → it *catches* IN1/IN3 8/8 escalation, the EV false positives, the BSN fabrication (proving the gate bites) → then goes green against the P3-1 end-state. Determinism assertions stable: run the golden set 3× in CI, identical pass/fail. Offline quality-eval scores match the previous in-line scores before removal. Gheg eval baselined at 54/100, improving as RC-25/P3-5 land.

**Testing.** Meta-testing: run against known-bad (pre-fix) and known-good (end-state) snapshots. Unit: assertion helpers (determinism comparator, token-membership, escalation-rate). Integration: shadow-diff runner against the ledger. The corpora are the regression suite for the whole program.

**Edge cases.** Hosted-model non-bit-determinism (RC-03 `accept` in Phase 13) — assert *decision class* + *fact membership*, not byte-identical prose. Small-N corpora (labelled) — expand over time. LLM-judge cost + non-determinism — offline/nightly only. Gheg corpus curation is an ongoing surface — assign an owner. The CI-blocking subset must run offline (no DB/Redis/network).

---

### P3-5 — Prompt-versioning & governance: allowlisted, token-budgeted, versioned assembly; prompt blocks as versioned data; footer-reach & orphan-block fixes
- **RCs addressed:** RC-26, RC-25, RC-17
- **Depends on:** P0-1, P1-5

**Strategy.** Prompt assembly is ungoverned and unversioned: the system prompt is **26–33K chars, unbudgeted** while only history is budgeted; an admin-created `offers_promotions` `tenant_prompt_block` — absent from migrations, catalog-inactive — is enabled for **6/6 tenants**, injecting ~1,478 chars referencing a nonexistent "Active offers" section (RC-26); the business-rules footer reaches **1 of 6 tenants** and `platform_restrictions` is **never rendered** (RC-25); five in-prompt rules (R6/R13/R16/R17) are contradicted by the guards. Build a governance layer: **(1) Allowlisted assembly + required-section assertions (RC-26):** the assembler (`aiService.ts:3919-4124`, `promptAssemblyService.ts`) validates enabled blocks against a committed allowlist; an unknown/orphan key is rejected and alerted, not injected; assert the footer renders for *every* tenant and `platform_restrictions` is rendered. **(2) Token budgeting for the whole prompt (RC-26):** per-section budgets + a hard ceiling; over-budget sections truncated by declared priority, not silently. **(3) Prompt blocks as versioned data (RC-17, RC-26):** move content out of migrations (C-142) into a versioned registry with immutable versions + a version id, so every reply links (via P1-5) to the exact block versions that produced it; removes prompt changes from the irreversible-migration class (ties to P3-3 step 2). **(4) Resolve rule/guard contradictions (RC-26):** with P3-1's consolidated gate replacing the post-hoc guards, reconcile R6/R13/R16/R17. **(5) Locked-block self-heal hygiene:** the force-sync currently runs on **every reply** — move it to an explicit sync/version-bump event, off the hot path.

**Regression risk.** Medium — prompt content is the model's entire behavioural surface; a wrong truncation or mis-scoped allowlist could drop a load-bearing instruction. Removing the orphan block changes 6/6 prompts (correct direction — it references a nonexistent section). Rendering the footer for all tenants is a behaviour change for the 5/6 missing it (intended). Versioning must preserve current live content as v1.

**Migration path.** (1) Snapshot current live `tenant_prompt_blocks` as **registry v1** (behaviour-neutral); wire P1-5 to record the block-version set per reply (observation). (2) Allowlist assertion in log-only mode — surface the orphan + any unknown keys without rejecting. (3) Remove the orphan; render the footer + `platform_restrictions` for all tenants behind a flag; validate on P3-4 evals. (4) Whole-prompt token budgeting behind a flag (measure prompt-size distribution first via P1-5). (5) Move locked-block self-heal off the hot path; reconcile R6/R13/R16/R17 once P3-1's gate is live.

**Rollback.** Registry v1 is a faithful snapshot — revert points assembly back at the legacy path (flagged). Allowlist starts log-only. Footer/orphan changes flagged per tenant. Token budgeting flagged. No destructive change until the registry has served production a full billing period clean.

**Validation.** The orphan `offers_promotions` is rejected/alerted, not injected; no reply's ledger row references it after the change. The footer + `platform_restrictions` render for **6/6** tenants (checkable from P1-5 provenance). Every assembled prompt within budget; over-budget truncates by priority + logs. Golden/fluency evals (P3-4) green across the changes; the Gheg eval improves. Per-reply reconstructability (§15.2): the exact block versions + footer presence for any historical reply.

**Testing.** Unit: allowlist validator; token-budget truncator (priority ordering); required-section assertion. Integration: assembly with an injected orphan key → rejected; assembly for a tenant previously missing the footer → present. Regression: prompt-provenance of a fixed tenant set stable; the orphan-block absence as a permanent fixture. Eval: P3-4 golden + Gheg suites.

**Edge cases.** Tenant-customized block content (legitimate) vs orphan key — the allowlist keys the *block type*, not the content. Multi-locale footer via the deterministic locale slot (P3-1), not a per-turn LLM call. Required sections (footer, restrictions) are never the truncated ones. A block version referenced by historical ledger rows stays immutable/retained. Force-sync of locked blocks is a new version, not a silent overwrite.

---

### P3-6 — Cost telemetry & model-tier optimization: per-conversation/tenant COGS, tiered model routing, budget alerting
- **RCs addressed:** RC-17, RC-03, RC-07, RC-08, RC-22
- **Depends on:** P1-5, P3-1, P3-4

**Strategy.** Spend is call-count-dominated and **entirely unmeasured**: `completion.usage` is discarded at every site (C-108) so a *usage-billed* product has **zero per-conversation COGS visibility**; ~28 of ~30 classifiers hard-route to full **gpt-4o** (C-103) for boolean decisions the DB already knows; the largest single term is `hasAssistantAskedOrderClosingInConversation` — an uncached per-assistant-message classifier run twice/job (~40 calls, C-126). P1-5 captures the telemetry; P3-1's routing collapse retires most of the fan-out. **(1) Per-conversation/tenant COGS aggregation (RC-03, RC-17):** aggregate P1-5's `completion.usage` (tokens × model price) per conversation/tenant/model; surface in the admin portal + a `credits`-adjacent metric (the OBS-2 gap). **(2) Tiered model routing (RC-17, RC-07, RC-08, RC-22):** the ~10× cost reduction is *primarily* P3-1 deleting ~20 classifier calls (RC-07/08/22 are exactly those retired classifiers). For the residual four roles, route by tier: slot-extraction + the ambiguity-only sensitive-intent classifier on a cheap/mini model; only the single grounded prose generation on the full model (respecting `custom_model_id`, and *not* silently dropped on image turns, C-99). Every surviving classifier honors a dedicated model env var. Never hardcode model names. **(3) Prompt-cost hygiene:** the 26–33K-char system prompt is re-sent uncached (C-24); pair with P3-5 budgeting + evaluate prompt caching for the static prefix. **(4) Budget alerting (RC-17):** alert on per-tenant/per-conversation cost anomalies (a runaway retry loop, a tenant whose COGS exceeds its commission, a model-tier misroute); model drift (finetuning base live `gpt-4o-2024-11-20` vs code/example `-mini`; the 900s delete-only cache serving different models mid-conversation) becomes visible once model-id is captured per call (P1-5).

**Regression risk.** Low-medium. COGS aggregation + alerting are read-only. Tiered routing **does** change behaviour — a cheaper model on slot-extraction could reduce accuracy, shifting order-creation/escalation — so every downgrade must pass the P3-4 evals before cutover (a mini model that regresses Gheg slot-extraction is a correctness regression, not just a cost win). Prompt caching must not change prompt semantics.

**Migration path.** (1) Aggregate P1-5's telemetry into COGS metrics + admin dashboards (observation only). (2) Budget/anomaly alerting. (3) **After P3-1's routing collapse**, tier the residual calls: A/B the cheap-model variant against full-model on the P3-4 corpora; downgrade only where evals hold; respect `custom_model_id` + per-role vars. (4) Evaluate + adopt prompt caching for the static prefix. (5) Continuously monitor COGS vs revenue per tenant.

**Rollback.** Telemetry/dashboards/alerts additive. Each model-tier route is a per-role config/flag — revert to the full model instantly if an eval regresses. Prompt caching is a call-param change.

**Validation.** Cost measurement: assert `completion.usage` captured on every call (P1-5) and COGS aggregates against a known token count; per-conversation cost visible in the admin portal (OBS-2/C-108 acceptance). Fan-out reduction: typical-turn completions drop 18–25 → ≤2 (shared with P3-1) and COGS/message drops ~10×. Tier-downgrade safety: every downgrade passes the P3-4 golden + Gheg + order-creation/escalation evals. Alerting: inject a runaway-cost scenario → a budget alert fires; inject a mid-conversation model switch → visible in the ledger + alertable.

**Testing.** Unit: COGS calculator; tier-router (role → model, respecting `custom_model_id` + env vars); anomaly detector. Integration: end-to-end cost capture across the residual fan-out; admin-portal COGS read. Eval: tier-downgrade A/B on P3-4 corpora as the gate. Regression: model-id-per-call captured; no hardcoded model names.

**Edge cases.** `custom_model_id` on chat but not vision (C-99) — tiering must not silently drop it on image turns. Model price table drift — externalize prices to config. A cheap model that regresses Gheg — the eval gate must include the Gheg corpus. Prompt caching invalidation — the cache key must include the prompt-version (P3-5). COGS telemetry storage — aggregate + retention (ride P1-5). Don't conflate cost and latency — streaming (C-95) helps perceived latency, not token cost.

---

## Root-cause coverage matrix

Every confirmed RC is addressed by at least one remediation item. **No coverage gap.** (Numbering note: `confirmed.json` contains no `RC-12` — the ledger jumps RC-11 → RC-13, so there are 25 confirmed RCs, not 26. Nothing to flag for RC-12.) Severities and WEAKENED disposition are from `rootcauses/confirmed.json`.

| RC-id | Severity | Remediation item(s) | Tier span (primary owner) |
|-------|----------|---------------------|---------------------------|
| RC-01 | Critical | P0-3, P1-5, P1-6, P2-1, P3-1, P3-4 | P0 → P3 (P0-3 interim; P2-1/P3-1 permanent) |
| RC-02 | Critical | P0-2, P0-3, P1-5, P1-6, P2-1, P3-1, P3-4 | P0 → P3 (P0-2 interim; P2-1/P3-1 permanent) |
| RC-03 | High | P1-5, P1-6, P2-1, P2-7, P3-1, P3-4, P3-6 | P1 → P3 |
| RC-04 | High *(WEAKENED)* | P0-2, P1-4, P1-5, P2-6, P2-7, P3-2 | P0 → P3 (P1-4 primary reliability) |
| RC-05 | High | P3-1, P3-2 | P3 (structural — serialized processing) |
| RC-06 | Medium | P0-5, P2-4, P2-7, P3-1 | P0 → P3 (P2-4 receipt-time snapshot) |
| RC-07 | Medium | P1-3, P2-2, P3-1, P3-6 | P1 → P3 (P1-3 primary) |
| RC-08 | Medium | P1-3, P2-2, P3-1, P3-6 | P1 → P3 (P1-3 primary) |
| RC-09 | High *(WEAKENED)* | P1-7 | P1 (sole owner) |
| RC-10 | Medium | P2-2, P2-5, P3-1 | P2 → P3 (P2-2 sticky-locale slot) |
| RC-11 | Medium | P2-4 | P2 (sole owner) |
| RC-13 | High | P2-3, P3-1 | P2 → P3 (P1 slot store + P2-3 completion) |
| RC-14 | High | P0-5, P3-1 | P0 → P3 (P0-5 interim; P3-1 FSM) |
| RC-15 | Medium *(WEAKENED)* | P2-1, P2-5, P2-7, P3-4 | P2 → P3 (factual→P2-1, fluency→P2-5/P3-4, threshold→P2-7) |
| RC-16 | Medium | P2-3, P3-1 | P2 → P3 (P2-3 primary) |
| RC-17 | Medium | P1-5, P2-3, P2-4, P2-7, P3-5, P3-6 | P1 → P3 (P2-3 versioned cache) |
| RC-18 | Medium | P0-6, P1-2, P3-2 | P0 → P3 (P0-6 interim; P3-2 structural) |
| RC-19 | High | P0-4, P2-6 | P0 → P2 (P0-4 sensitive; P2-6 fleet-wide) |
| RC-20 | High | P1-1, P1-2, P2-4, P3-2 | P1 → P3 (P1-1 primary) |
| RC-21 | High | P1-1, P1-2, P2-4 | P1 → P2 (P1-1 primary) |
| RC-22 | Medium | P0-4, P1-5, P2-2, P3-1, P3-6 | P0 → P3 (P2-2 order-stage machine) |
| RC-23 | Medium | P0-1, P3-3, P3-4 | P0 → P3 (P0-1 gate; P3-3 framework) |
| RC-24 | Medium | P0-7 | P0 (interim; P1/P2-4 durable registry extends) |
| RC-25 | Medium | P2-5, P3-4, P3-5 | P2 → P3 (P2-5 program) |
| RC-26 | Medium | P2-5, P3-5 | P2 → P3 (P3-5 governance) |

**Coverage check result:** 25 / 25 confirmed RCs covered. **0 uncovered.**
**Phantom-reference check result:** every `addressesRCs` value across all 27 items resolves to a real RC-id in `confirmed.json`. **0 phantom references** (no item cites RC-12 or any non-existent id).

---

## Sequencing & dependencies

### Week-0 prerequisite (RC-23) — non-negotiable

`P0-1` (CI runs the 548-suite, `deploy-staging` gated on CI via `workflow_run`, migration runner made safe with an advisory lock + duplicate-ordinal fail-fast) **must land before any other code-touching item in any tier.** Every P0 code item declares `dependsOn: P0-1`, and every P1/P2/P3 item transitively depends on it. Rationale (Phase 12 §Migration): shipping guard/pause/billing/architecture changes onto a pipeline that runs zero tests and lets a red-CI commit auto-deploy to staging is malpractice — the eval fixtures the whole program relies on (golden determinism, EV-replay, fabrication token-membership) have nowhere to run until CI executes the suite. `P3-4` (standing eval harness) is the second enabler and should be live before P3-1's large behaviour-changing cutovers flip on.

### Ordering-violation check

- **P0 → P1+ rule:** every P0 item's `dependsOn` points only to other P0 items (P0-1 for six of them; P0-5 additionally on P0-6). **No P0 item depends on a P1, P2, or P3 item. 0 ordering violations.**
- **Whole-graph acyclicity:** no item anywhere depends on a later-tier item. Cross-tier edges all point backward (P1→P0, P2→P0/P1/P2, P3→P0/P1/P3). The one within-tier P1 edge (P1-5 → P1-6) and the P1-5 → P1-1 edge form no cycle. **Graph is a valid DAG.**

### Safe execution order

**Week 0 — gate the pipeline (must complete first)**
1. **P0-1** (RC-23) — CI test-gate + deploy-on-CI + safe migration runner.

**P0 wave — stop the bleeding (all `dependsOn: P0-1`; internal order shown)**
2. **P0-6** (RC-18) — delivered-only rate counting. *(Land before P0-5, which reads the counter.)*
3. **P0-2** (RC-02/04) → **P0-3** (RC-01/02) — full-catalog guards, then the deterministic-first gap gate (P0-3 `dependsOn` P0-2).
4. **P0-4** (RC-19/22), **P0-7** (RC-24) — sensitive-path fail-closed; echo corroboration. *(Independent; parallelizable.)*
5. **P0-5** (RC-14/06) — AI auto-resume (`dependsOn` P0-1, P0-6).

**P1 wave — the hybrid spine (this quarter)**
6. **P1-6** (PII redaction) — foundational precondition for P1-5; `dependsOn` P0-1.
7. **P1-1** (RC-20/21) — idempotent post-send outbox/staging substrate; `dependsOn` P0-1.
8. **P1-2** (RC-21/20/18) — DLQ + failure classification; `dependsOn` P1-1, P0-4.
9. **P1-5** (RC-03/17/01/02/04/22) — decision ledger; `dependsOn` P1-1, P1-6. *(The measurement instrument for later shadow windows and boost-rate measurement.)*
10. **P1-3** (RC-07/08), **P1-4** (RC-04), **P1-7** (RC-09) — confidence-contract symmetry; retrieval reliability; channel-isolation. *(Each `dependsOn` P0-1 only; parallelizable; P1-3's rollout benefits from P1-5's boost measurement.)*

**P2 wave — complete the hybrid (next quarter). Recommended internal order: land P2-4 first as the observing instrument.**
11. **P2-4** (RC-06/11/17/20/21) — decision-ledger substrate + receipt-time snapshot + dedupe replay + structured logging; `dependsOn` P0-6, P0-7, P2-1. *(Ship the ledger/logging shadow first; it makes every other P2 item's shadow window observable.)*
12. **P2-1** (RC-02/01/03/15) — consolidated grounding gate + `facts_used` contract; `dependsOn` P0-2, P0-3. *(Supersedes P0-2/P0-3.)*
13. **P2-2** (RC-07/08/22/10) — classifier consolidation; `dependsOn` P2-1, P0-4, P0-6.
14. **P2-3** (RC-16/17/13) — memory/history redesign + versioned config cache; `dependsOn` P0-5.
15. **P2-5** (RC-25/26/10/15) — Albanian/Gheg program + prompt hygiene; `dependsOn` P2-1, P2-2.
16. **P2-6** (RC-19/04) — circuit breakers + graceful degradation; `dependsOn` P0-4, P2-2, P2-4.
17. **P2-7** (RC-15/04/06/17) — config-drift boot-time hardening; `dependsOn` P0-1, P2-4.

**P3 wave — strategic end-state (backlog). Enablers P3-3 and P3-4 start right after P0-1; P3-4 must be live before P3-1's cutovers.**
18. **P3-3** (RC-23) — reversible/atomic migration framework; `dependsOn` P0-1.
19. **P3-4** (RC-01/02/03/15/25/23) — standing eval harness; `dependsOn` P0-1, P0-2, P0-3, P1-5. *(Hard gate for P3-1.)*
20. **P3-2** (RC-18/05/04/20) — horizontal worker fleet + isolation + partitioning; `dependsOn` P0-1, P0-6, P1-1, P1-2. *(Largely orthogonal infra; parallelizable; fan-out-dependent wins land after P3-1.)*
21. **P3-1** (RC-01/02/03/05/06/07/08/10/13/14/16/22) — the full hybrid end-state; `dependsOn` P0-2, P0-3, P0-4, P0-5, P1-1, P1-3, P1-5, P3-4. *(Largest behavioural surface; per-decision flags + shadow-diff + canary.)*
22. **P3-5** (RC-26/25/17) — prompt governance/versioning; `dependsOn` P0-1, P1-5. *(Rule-reconciliation portion depends on P3-1's gate being live.)*
23. **P3-6** (RC-17/03/07/08/22) — cost telemetry + tiered routing; `dependsOn` P1-5, P3-1, P3-4. *(The ~10× cost win is P3-1's fan-out collapse.)*

### Dependency notes

- **Interim → permanent supersession chains** (the stop-gaps buy time; the later items are the permanent build): P0-2/P0-3 → P2-1 → P3-1 (guards → consolidated gate → single grounded generation); P0-5 → P3-1 (auto-resume interim → resumable FSM); P0-6 → P3-2 (delivered-only counter → structural fair-share queueing); P0-7 → P2-4 (echo content-corroboration → durable `external_message_id` registry); P0-1 → P3-3 (advisory-lock/dup-assertion stop-gap → reversible framework); P1 slot store → P2-3 → P3-1 (anchor-loss fix → memory redesign → versioned end-state).
- **P2 edges into P3** are named in prose in the P3 tier (P3-1 consumes the P2 interim slot store, resumable-FSM, deterministic locale, delivery-filtered history, and receipt-time snapshot and promotes them to the versioned end-state; P3-3 step 2 depends on P2 prompt-hygiene precursors). Wire these `dependsOn` edges when scheduling P3 against a landed P2.
- **P1-5 is the pivot instrument.** Its decision ledger is what makes P1-3's boost-rate measurement, P2-x shadow windows, P3-4 shadow-diffing, and P3-6 cost telemetry observable rather than inferred. Prioritize it early within P1, immediately after P1-1 (its outbox substrate) and P1-6 (its mandatory PII-redaction precondition).

---

*Phase 16 deliverable — Prioritized Remediation Roadmap. 27 remediation items across 4 tiers, anchored to the 25 confirmed root causes (22 CONFIRMED + 3 WEAKENED, `rootcauses/confirmed.json`) and the Phase 12 hybrid target. Design only — no product source edited; every citation references commit `a8ceb15`. Checks: 25/25 RCs covered (0 gaps), 0 phantom RC references, 0 P0→P1+ ordering violations.*
