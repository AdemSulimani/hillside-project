# Phase 11 — Root Cause Analysis

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts) and live-replay experiments (Phase 10, small-N). Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md for verbatim query evidence.

**Arbiter note.** The blind-verifier verdict payload was not delivered to this arbiter (the orchestrator template was not interpolated and no verdict artifact existed on disk). Rather than rule blind, the arbiter re-verified every load-bearing code citation for all Critical/High candidates directly in source (`productInformationGapService.ts`, `aiService.ts`, `processAIReply.ts`, `processInboundMessage.ts`, `channel.ts`, `webhookNormalizer.ts`, `outboundEchoRegistry.ts`, `message.ts`/migration `012`, `ci.yml`, `deploy.yml`) and adjudicated each candidate on that first-hand reading plus the Phase 1–10 evidence chain. One candidate (RC-12) was **refuted by source** on its distinctive mechanism; three were **weakened**; the rest **confirmed**. Nothing was silently dropped — refuted/heavily-narrowed material is preserved in appendix-B-unconfirmed-hypotheses.md.

**Issues under investigation.**
- **Issue 1 — Nondeterministic divergence:** byte-identical inbound produces different outcome *classes* (correct answer vs. wrong answer vs. escalate+pause vs. silence).
- **Issue 2 — Depth degradation:** conversations that answer correctly early degrade later into wrong recommendations, re-asked info, or permanent silence.

---

## Executive causal summary

**Issue 1 (identical input → divergent outcome)** is driven, top-down, by **RC-01**, **RC-03**, and the cross-cutting **RC-02**. Every inbound question passes through stochastic LLM sub-decisions that are then hard-thresholded into outcome classes: the reply itself is sampled at temperature 0.3 with no seed (**RC-03** — live-replay measured 1, 3, and 8 distinct replies for three fixed inputs, one fabricating facts), and a fail-closed, English-prompted "did we fully answer this?" assessor (**RC-01**) converts answerable Albanian catalog questions into escalations — live-replay saw 8/8 escalations on a plain availability question, with the escalation reason itself non-deterministic at temperature 0. Underneath both, the hallucination and gap guards judge the generated reply only against *this turn's* retrieval window rather than the catalog (**RC-02**), so a correct answer about a real, active product is stripped or escalated whenever that product is not in the current ~10–25-item window. These three interact multiplicatively with a long tail of timing- and boundary-sensitive gates (RC-04–RC-11) so that the same message reaches answer, wrong-answer, escalate, or silence depending on sampling, retrieval timing, confidence-field formatting, and toggle/latency state — none of which is content.

**Issue 2 (correct-early → degrades-later)** is driven by **RC-14**, **RC-13**, and again **RC-02**. As a conversation lengthens, load-bearing facts and the last recommendation's `product_ids` anchor slide out of the 40-row history window (**RC-13** — 10 documented anchor-loss events), so late-turn classifiers and generation run without context the customer already gave. When a window-relative guard (**RC-02**) then escalates a correct-but-out-of-window reply, that escalation almost always lands on the final turn (Q7: 14/20 alerts), and there is **no automatic AI resume anywhere in the code** (**RC-14**) — every pause exits only via a human toggle or an alert resolved with `resume_ai:true`. The result is the dominant observed end-state: the AI answers early turns well, then goes permanently silent. History re-feeding of flagged/undelivered replies (RC-16), per-worker persona/model cache drift (RC-17), phantom rate-limit pauses (RC-18), and self-echo mis-handling (RC-24) all accelerate the same slide. The single previously-nominated "strongest Issue-2 case," RC-12, was refuted on inspection — its true effect is not a swapped-in wrong product but exactly the escalate-to-holding-message-then-silence path already captured by RC-02 + RC-14.

---

## Confirmed & weakened root causes

Ordering: Issue-1 causes, then Issue-2 causes, then cross-cutting — most severe first within each group.

### Issue 1 — nondeterministic divergence

---

#### RC-01 — Fail-closed, non-deterministic product-info-gap escalation gate — **CONFIRMED**

- **Severity:** Critical
- **Confidence:** High. Live-replay *measured* it (IN1 8/8 escalate on a plain availability question; IN3 8/8 escalate with a non-deterministic escalation reason at temp 0). Fail-closed behaviour re-verified in source by the arbiter.
- **Root Cause:** `assessProductInformationRequest()` decides `escalate = (!ok || missing.length > 0)` from a stochastic LLM call whose system prompt is English while the customer text is Albanian; on parse/transport failure it returns `{ answer:'', missing:[], ok:false }` — i.e. it **fails CLOSED to escalate**. The assessor re-runs per turn, so byte-identical input resolves "answered" on one execution and "escalate + alert + pause" on another with no catalog or text change.
- **Mechanism:** attribute-intent flags `is_product_knowledge_question` → assessor called with `(input, catalogCtx)`. At temp 0 the model still emits different missing-sets across runs (IN3: 4×`['cila eshte me e mire']`, 4×`['më e mirë']`); IN1 flags `['marka']` (brand) though brand is null for *all* matched rows and the customer only asked availability. `escalate=true` ⇒ `product_question_unanswered` alert + partial-answer + `ai_paused`. A run where the model returns `[]` sends a normal answer.
- **Supporting Evidence:** `backend/src/services/productInformationGapService.ts:72` (`const failed = { answer:'', missing:[], ok:!failClosed }`), `:105-107` (`catch → console.warn('...failing closed') → return failed`); English MULTI-PRODUCT prompt at `:39-59`. EV-044; DP-gg-14; `docs/audit/10-runtime-verification.md` (IN1 8/8, IN3 8/8). R16-correction (WF-D): single-product price+attribute questions bypass the RECOMMENDATION_COMPARISON exclusion and enter the assessor.
- **Runtime Evidence:** live-replay Phase C ran the assessor ×8/input: IN1 escalate 8/8 `missing=['marka']`; IN3 escalate 8/8 with a non-deterministic missing-set.
- **Disconfirming Evidence:** none survived. Would collapse only if re-runs yielded a stable answer/escalate decision, or if the assessor failed *open* on transport error (source shows the opposite: `ok:!failClosed`, default `failClosed=true`).
- **Affected Files/Functions:** `backend/src/services/productInformationGapService.ts` (`assessProductInformationRequest`), `productAttributeIntentService.ts` (trigger), `jobs/processAIReply.ts` (gap-guard invocation, S-48).
- **Real-World Impact:** correct, answerable catalog questions become escalations that pause and (per RC-14) end the conversation. Primary measured driver of the Issue-1 answer-vs-escalate split and a major false-escalation source.
- **Risk if unaddressed:** the platform's core value proposition (autonomous product Q&A) inverts into a systematic escalation/silence generator on its most common message type, in its core dialect.
- **Regression Prevention:** golden-set automated check — a fixed corpus of answerable single- and multi-product availability/attribute questions (Albanian + Gheg + English) asserted to produce a normal answer, run N≥20× per input with a hard **determinism assertion** (identical decision every run) and a **max-escalation-rate** threshold. Fail the build on any flip. Fail-closed→fail-open transport-error path covered by an injected-error unit test. LLM-as-judge is unnecessary here — the decision is a discrete escalate/answer label, checkable exactly.

---

#### RC-03 — Reply generation at temperature 0.3, no seed — identical prompt yields divergent (sometimes fabricating) replies — **CONFIRMED**

- **Severity:** High
- **Confidence:** High. Default `0.3` verified in source (`aiService.ts:122-125`); live-replay measured `distinctRepliesPerInput=[1,3,8]` on three fixed inputs.
- **Root Cause:** `AI_REPLY_TEMPERATURE` resolves to **0.3** by default with no fixed seed and no `response_format` on the main reply, so the same assembled prompt sampled twice produces different wording — from a degenerate one-word answer (IN1 "Po.") to 8 different paragraphs (IN3), some fabricating claims absent from the catalog that still pass the name-guard and quality-eval.
- **Mechanism:** `generateReply` builds an identical prompt (same `matchedProducts`, same catalog context) → chat completion at temp 0.3 → stochastic sampling. IN2 drops the product name in 2/8 runs; IN3 fabricates "BSN = Bio-Engineered Supplements and Nutrition" + strength claims in several runs. Downstream guards then judge each different text differently, compounding into different outcome classes.
- **Supporting Evidence:** `backend/src/services/aiService.ts:122-125` (temp default 0.3); guard/classifier calls by contrast pin `temperature:0` (`:1029,1065,1101,1141,1192,1229`). EV-044; `docs/audit/10-runtime-verification.md`; `runtime/live-replay.md` (Phase B ×8).
- **Runtime Evidence:** Phase B replayed the same captured prompt 8×; `distinctRepliesPerInput=[1,3,8]`; IN3's fabricated BSN expansion passed name-guard + quality-eval.
- **Disconfirming Evidence:** none survived. Would refute if production pinned a seed/temp 0 or `response_format`; source shows an env-driven default of 0.3 and no seed.
- **Affected Files/Functions:** `backend/src/services/aiService.ts` (`generateReply` completion params).
- **Real-World Impact:** baseline wording nondeterminism on identical input; interacts with every downstream guard (RC-02, RC-01) so the same input can land answer/wrong/escalate. Also a direct fabrication vector.
- **Risk if unaddressed:** unreproducible customer-facing behaviour (support cannot recreate a complaint), and fabricated product claims shipped to customers.
- **Regression Prevention:** automated check that replays a fixed prompt N≥8× and asserts (a) a cap on distinct normalized replies and (b) zero product-claim tokens absent from the injected catalog (deterministic token-membership check, not a judge). Pair with a config assertion that `AI_REPLY_TEMPERATURE`/seed are within an approved band. Reserve LLM-as-judge only for the residual "is this wording acceptable" question, not for the fabrication check.

---

#### RC-05 — Timing-dependent burst composition / 8s-debounce decides merge vs separate vs stale-skip — **CONFIRMED**

- **Severity:** High
- **Confidence:** Medium-High. Multiple corroborating DP rows on the debounce/merge/stale interplay; code-confirmed debounce window.
- **Root Cause:** the pipeline merges "inbound messages after the most recent OUTBOUND, last 5" and debounces with an 8s delayed job (`AI_REPLY_DELAY_MS=8000`) that can see only `delayed`/`waiting` (not `active`) jobs and removes at most one pending job. So whether two rapid messages become one merged reply, two separate replies, or one reply plus a stale-skip silence is decided by sub-second arrival timing and outbound-persist ordering, not content.
- **Mechanism:** Msg A at *t*, Msg B at *t+dt*. B arriving while A's job is delayed (<8s) ⇒ debounce merges ⇒ one reply over "A B". B arriving after A's job went active ⇒ two jobs ⇒ two replies, or the older job hits the stale-job guard and exits silently. Merged text feeds every classifier and the main prompt.
- **Supporting Evidence:** DP-iq-16 (`processInboundMessage.ts` debounce, `AI_REPLY_DELAY_MS 8000` — verified: `getJobs(['delayed','waiting'])` then `.find` then single `.remove()`), DP-iq-17, DP-GPR-10/11/12, DP-pc-09.
- **Disconfirming Evidence:** attenuated (not refuted) if production inter-message gaps are almost always ≫8s; the mechanism is code-certain, its incidence is traffic-shape dependent.
- **Affected Files/Functions:** `backend/src/jobs/processInboundMessage.ts` (burst/debounce), `jobs/processAIReply.ts` (burst assembly, stale guard).
- **Real-World Impact:** identical message pairs diverge in reply count, merged text, and downstream classifier outcomes; can produce silence for one message of a burst.
- **Risk if unaddressed:** customers who send a thought across two bubbles get inconsistent handling; a merchant cannot predict reply count.
- **Regression Prevention:** integration test that enqueues the same two-message burst at a matrix of inter-arrival gaps (0.1s–20s) and asserts a single deterministic merge outcome (one reply over concatenated text) below the debounce window and no silent stale-skip. Serialized per-conversation processing would make this assertion pass deterministically.

---

#### RC-07 — Confidence-boost asymmetry across escalation vs order detectors — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Four boost sites + the missing boost on the order path code-confirmed (DP-GPR-16).
- **Root Cause:** when the classifier model asserts an intent boolean `true` but omits/zeroes `confidence`, four detectors (cancel/refund, wrong-product, post-purchase, order-info-update) overwrite confidence to 0.9/0.85 — clearing their >0.8/>0.82 gate on the boolean alone — while `detectOrderAffirmationIntent` has **no** such boost, so its missing-confidence case *fails* its >0.7 gate. Identical malformed-but-parseable output therefore over-escalates on four paths and under-creates orders on one.
- **Mechanism:** model returns `{is_refund:true, confidence:0}` → code sets `0.9` → gate passes → canned ack + order flag + alert + pause. Same quirk on affirmation → confidence stays 0/undefined → gate fails → no draft order. Whether the field is emitted is itself stochastic.
- **Supporting Evidence:** DP-GPR-16 (`aiService.ts:2509`; siblings `:2584-2586, :2686-2688, :2888`); DP-po-30 (affirmation inside the 7-conjunct gate); findings-seed "4 detectors boost confidence 0 → 0.85/0.9".
- **Disconfirming Evidence:** attenuated if the model reliably emits a real confidence value; the asymmetry itself is code-certain.
- **Affected Files/Functions:** `backend/src/services/aiService.ts` (`detect*` confidence normalization).
- **Real-World Impact:** over-escalation on malformed output (Issue-1 escalate arm) and asymmetric loss of orders/commission when the model omits confidence on the affirmation path (billing leak).
- **Risk if unaddressed:** revenue leakage skewed by a formatting quirk, plus escalation noise — both invisible without instrumentation.
- **Regression Prevention:** unit tests feeding each detector `{intent:true, confidence:0}` and `{intent:true}` (missing) and asserting a *single, consistent* fail-direction policy across all five detectors (either all boost or none). Add a contract test that the classifier prompt+schema make `confidence` required.

---

#### RC-08 — Outcome-class routing on fixed confidence boundaries over noisy scores — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium. Boundary fragility is inherent to threshold gating on stochastic scores (DP-GPR-15, C-74); the thresholds and their tension are code-confirmed.
- **Root Cause:** routing is gated on hard thresholds applied to non-deterministic classifier scores — cancellation/refund at `confidence>0.8`, and an internal intent-prompt tension between a 0.75 band label (line 120) and the 0.85 draft-order threshold (line 131). Messages whose true confidence hovers at the boundary flip between escalate+pause and normal reply, or order vs no-order, across identical runs.
- **Mechanism:** ambiguous message → classifier returns ~0.8 ± noise → 0.81 ⇒ canned ack + pause; 0.79 ⇒ normal reply. Same words, opposite class.
- **Supporting Evidence:** DP-GPR-15 (`processAIReply.ts` `confidence>0.8` cancel/refund gate), C-74 (intent prompt 0.75 vs 0.85), `INTENT_THRESHOLD` live 0.85 (WF-G).
- **Disconfirming Evidence:** attenuated if real-message scores are bimodal and cluster far from thresholds; unquantified in dev.
- **Affected Files/Functions:** `backend/src/jobs/processAIReply.ts` (cancel/refund gate), `services/intentDetectionService.ts`.
- **Real-World Impact:** maximally divergent outcome classes for boundary phrasing.
- **Risk if unaddressed:** the most consequential routing decisions (refund vs sales; order vs not) are the least stable.
- **Regression Prevention:** a boundary-corpus check — messages engineered to sit near each threshold, replayed N× — asserting either a deterministic label or an explicit hysteresis/margin band that resolves consistently. Track score distributions in staging to confirm/deny bimodality before relying on it.

---

#### RC-06 — Enablement gates and knobs evaluated at job-run time (≥8s after receipt) with mixed env read-lifetimes — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Run-time gate evaluation code-confirmed (DP-iq-23, DP-GPR-31).
- **Root Cause:** all three enablement gates (`ai_configs.is_active`, `channels.ai_enabled`, `conversations.ai_paused`/`human_override_until`) and several knobs (`AI_MAX_REPLIES_PER_HOUR` re-read per job; `HUMAN_HOLD_MINUTES` per call; `AI_MAX_CONCURRENT`/`LOCK_TTL`/`HISTORY_FETCH` frozen at module load) are read at *job execution*, ≥8s (often minutes) after receipt. Any toggle flip or per-instance env drift in that window changes an already-received message's outcome class with no artifact that a received message was discarded.
- **Mechanism:** received → queued with 8s delay (+fairness/lock/hold reschedules). At run time the gates are checked. Admin toggles AI off, a human reply lands, or a rolling deploy changes a knob between workers ⇒ identical messages a second apart diverge reply/silence, or run under different caps/history depths (history depth changes the slice every pre-reply detector sees).
- **Supporting Evidence:** DP-iq-23 (`processAIReply.ts:1296`), DP-GPR-31 (mixed read lifetimes), WF-G config-drift table (`QUALITY_THRESHOLD` live 0.1 vs example 0.6; finetuning base drift).
- **Disconfirming Evidence:** attenuated if toggles are rare relative to the receipt-to-run window and all instances run identical env.
- **Affected Files/Functions:** `backend/src/jobs/processAIReply.ts`, `services/conversationService.ts`, `services/aiService.ts:108`.
- **Real-World Impact:** identical messages diverge reply vs silent-drop on toggle/hold/config timing; multi-instance env drift makes worker identity a hidden variable.
- **Risk if unaddressed:** deploys and admin actions silently reclassify in-flight messages; non-reproducible incidents.
- **Regression Prevention:** snapshot gate/config state at *receipt* into the job payload and evaluate against the snapshot (or record it), so behaviour is a function of receipt-time state; add a startup assertion that all instances read identical env for the frozen-at-load knobs (fail deploy on drift).

---

#### RC-10 — Reply language chosen by a temp-0 LLM/heuristic with a hard 'sq' default — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium. Fallback chain code-confirmed (DP-GPR-14).
- **Root Cause:** for messages the marker heuristic cannot resolve, reply language is decided by a low-variance LLM call that gates the language of the *entire* reply (holding text, ETA, order confirmation); on transport error it falls to recent-turn heuristics and ultimately hard-defaults to `'sq'`. An English speaker with an ambiguous message can get Albanian on one run, English on another.
- **Mechanism:** ambiguous inbound → no unambiguous marker → LLM language call (or on error → heuristic → default `'sq'`) → the label gates all canned/generated text.
- **Supporting Evidence:** DP-GPR-14 (`aiService.ts:1837`); WF-E (English-prompted classifiers judge Albanian); findings-seed WF-E score 54/100.
- **Disconfirming Evidence:** attenuated if nearly all real inbound carry unambiguous markers, or channel/profile locale pins language upstream.
- **Affected Files/Functions:** `backend/src/services/aiService.ts` (reply-language decision).
- **Real-World Impact:** wrong-language replies for a subset of ambiguous messages; interacts with RC-25 dialect gaps.
- **Risk if unaddressed:** customers receive replies in the wrong language, undermining trust — worst for the canned escalation/holding messages that already dominate failure paths.
- **Regression Prevention:** deterministic language resolution (prefer channel/contact locale, then a stable marker rule) with an automated test over an ambiguous-message corpus asserting a single language per input across runs; assert the hard `'sq'` default is only reached when locale is genuinely unknown.

---

#### RC-11 — Webhook freshness gate: Date.now() fallback passes replays, 300s skew 403s late-but-valid deliveries — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Code-confirmed (DP-iq-01/02).
- **Root Cause:** `eventEpochMs = payloadTsMs ?? Date.now()`: a payload *without* a timestamp always passes (`|now-now|=0`) regardless of true age, while a payload *with* a timestamp older than `WEBHOOK_TS_MAX_SKEW_MS=300000` is 403'd and never enqueued — and Meta redelivers the same stale timestamp forever. Outcome depends on timestamp presence/latency, not content.
- **Mechanism:** no-timestamp delivery ⇒ passes gate ⇒ processed (even a replay). Delivery arriving >300s after its embedded timestamp (Meta retry burst, backlog) ⇒ 403, no traceId, no job, no DB row ⇒ permanent silence, while a promptly-delivered identical message is answered.
- **Supporting Evidence:** DP-iq-01 (`webhookController.ts:303`), DP-iq-02 (`:304`), `viberWebhookController.ts:168` (Viber top-level timestamp).
- **Disconfirming Evidence:** attenuated if platform deliveries are effectively always <300s and always carry timestamps.
- **Affected Files/Functions:** `backend/src/controllers/webhookController.ts`, `viberWebhookController.ts`.
- **Real-World Impact:** silent drop of late-delivered valid messages; replay-acceptance of timestamp-less payloads. Contributes to answer-vs-silence divergence.
- **Risk if unaddressed:** during any platform-side delay/backlog, a burst of valid customer messages is 403'd into permanent silence with no artifact.
- **Regression Prevention:** replace the skew-403 with dedupe-based replay protection (accept + idempotency key) so late-but-valid messages are processed once; unit tests for (a) missing-timestamp payload rejected-as-replay only via dedupe, (b) 6-minute-late valid delivery still enqueued exactly once.

---

### Issue 2 — depth degradation

---

#### RC-14 — Escalations fire at the final turn and there is NO AI auto-resume — every pause is a permanent silent dead-end — **CONFIRMED**

- **Severity:** High
- **Confidence:** High. Q7 (14/20 alerts at final turn) + Phase 5 six dead-end states; arbiter re-verified there is no auto-resume path (9 `setConversationAiPaused(...,true)` sites in `processAIReply.ts`; resume only via `resume_ai:true` in `aiAlertController.ts:93,115`).
- **Root Cause:** `ai_paused`, the rate-limit pause, and `human_override` have no automatic re-enable anywhere in code. Pauses exit only via a human toggle or an alert resolved with explicit `resume_ai:true`, and alert resolution defaults to leaving `ai_paused=true`. Because escalations (which set the pause) overwhelmingly fire on the last turn, a healthy conversation degrades into permanent silence the moment any guard escalates.
- **Mechanism:** guard escalates on turn N → `setConversationAiPaused(true)` + alert. No cron/timer/inbound event clears it. Rate-limit pause persists after the 1h Redis counter expires (nothing re-evaluates). Alert resolved without `resume_ai:true` ⇒ pause stays true. Reopening a closed conversation force-sets `status='open'` but `ai_paused` survives.
- **Supporting Evidence:** Q7 (WF-C: 14/20 alerts at final turn); Phase 5 six dead-end states; `jobs/processAIReply.ts:1251,1471,1530,1741,2025,2079,2147,2188,2435` (pause sites, all `true`); `controllers/aiAlertController.ts:93,115,123` (resume gated on `resume_ai===true`).
- **Runtime Evidence:** 20 dev `ai_alerts`, 14/20 at the conversation's final turn (Q7).
- **Disconfirming Evidence:** none survived — the arbiter searched for and found no cron/inbound-triggered/default-resume path.
- **Affected Files/Functions:** `backend/src/jobs/processAIReply.ts` (pause sites), `controllers/aiAlertController.ts` (resolve), `services/conversationService.ts`.
- **Real-World Impact:** the dominant Issue-2 end-state — correct-early conversations degrade to indefinite silence; also suppresses use-case billing signal and merchant visibility.
- **Risk if unaddressed:** every false escalation (RC-01, RC-02) becomes a permanently abandoned customer; the failure is terminal, not transient.
- **Regression Prevention:** implement and test an auto-resume policy (e.g. resume on next inbound after human-hold expiry, or default `resume_ai:true` on non-sensitive alert resolution) with an integration test asserting `ai_paused` clears on the defined trigger; add an invariant check that no conversation remains `ai_paused` with an inbound newer than the pause and no open alert.

---

#### RC-13 — 40-message history window + lost product_ids anchor drop load-bearing facts as the conversation grows — **CONFIRMED**

- **Severity:** High
- **Confidence:** High. Q3 documented 10 anchor-loss events on order-flow/escalation replies; `LIMIT 40` window code-confirmed (DP-pc-09, `message.ts`).
- **Root Cause:** history is the most recent `AI_HISTORY_FETCH_LIMIT=40` rows scoped only by `conversation_id`, and `product_ids` (the recommendation anchor) empties precisely on order-flow and escalation replies. As a conversation lengthens (and retries/canned-acks/notes add rows), earlier stated facts — address, phone, allergy, last recommendation — slide out of the window, so later-turn classifiers and generation run without context the customer already gave.
- **Mechanism:** row 41-back is invisible to both the raw window and the older-summary input. Escalation-heavy turns roll the last recommendation's `product_ids` out of the window → a follow-up chain ends in a fail-closed classifier that can *deny* a product the AI recommended earlier. Any extra row between executions slides the window and can push a stated address/phone out of the model's world → re-asks or wrong order fields.
- **Supporting Evidence:** Q3 (10 anchor-loss events, WF-C); DP-pc-09 (`message.ts:313`, `LIMIT 40`); DP-retrieval-12/14/15 (`product_ids` anchor lost → fail-closed classifier); `AI_HISTORY_FETCH_LIMIT` live 40 (WF-G).
- **Disconfirming Evidence:** attenuated if a rolling summary reliably preserves load-bearing facts beyond 40 rows (it does not — the summary is background context, not a structured fact store), or if real conversations rarely exceed 40 rows.
- **Affected Files/Functions:** `backend/src/db/models/message.ts:313`, `services/aiService.ts` (history assembly), `jobs/processAIReply.ts` (`product_ids` anchor).
- **Real-World Impact:** progressive context loss with depth → re-asking known info, denying previously-recommended products, wrong order fields. Core Issue-2 degradation.
- **Risk if unaddressed:** longer (higher-intent, closer-to-order) conversations are exactly the ones that degrade — the platform loses its best sales opportunities to context loss.
- **Regression Prevention:** a structured conversation-state store (extracted address/phone/name/last-recommendation persisted per conversation and always injected regardless of window), with an integration test over a 50+ turn scripted conversation asserting the model never re-asks a previously-provided field and never denies a previously-recommended in-stock product.

---

#### RC-16 — Unfiltered history re-feeds flagged-hallucination and never-delivered replies as assistant turns — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Role mapping ignores `flagged`/send status — verified in source (`aiService.ts:3115-3118`, `role = sent_by==='customer' ? 'user' : 'assistant'`).
- **Root Cause:** history assembly maps every non-customer row to role `assistant` regardless of `msg.flagged` or send status, so replies a guard flagged as hallucinated *and* replies never actually delivered are fed back to the model as if the AI had said them. The model then builds on its own bad or phantom prior output.
- **Mechanism:** turn N reply flagged/blocked/send-failed but persisted → row with `sent_by!='customer'`. Turn N+1 history load maps it to assistant → model conditions on content the customer never saw / that was flagged wrong → continues the error thread → later replies inherit and extend the drift.
- **Supporting Evidence:** verified `aiService.ts:3115-3118`; DP-pc-14; findings-seed WF-B.
- **Disconfirming Evidence:** attenuated if flagged/failed rows are excluded upstream (they are not) or are rare.
- **Affected Files/Functions:** `backend/src/services/aiService.ts:3115` (history mapping).
- **Real-World Impact:** compounding degradation across turns; the model treats phantom/flagged text as established context.
- **Risk if unaddressed:** a single flagged hallucination poisons every subsequent turn of the conversation.
- **Regression Prevention:** exclude `flagged=true` and non-delivered rows (or mark them as failed/redacted) in history assembly; unit test asserting a flagged/undelivered row is not emitted as an `assistant` message; integration test that a hallucination flagged on turn N does not reappear as grounding on turn N+1.

---

#### RC-17 — Delete-only 900s ai_config cache carrying custom_model_id → per-worker persona/model drift — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium. `EX 900` cache with delete-only invalidation and `custom_model_id` in the cached config — verified (`aiService.ts:228`, `:4108`).
- **Root Cause:** `ai_config:{tenantId}` is cached 900s with delete-only invalidation and carries `custom_model_id`; locked prompt blocks self-heal on every reply. Within 900s of an admin edit (or via a mutation path that skips `invalidateTenantAiCaches`, e.g. the tenant AI toggle), worker A (pre-edit cache) and worker B (post-invalidation) assemble different system prompts and can call **different models** for the same tenant state.
- **Mechanism:** admin edits tone/restrictions/`custom_model_id` → delete-only invalidation. Worker A holds the pre-edit copy up to 900s → old persona + old model; worker B fetches fresh → new persona/model. Consecutive turns on different workers ⇒ the AI's voice/model changes mid-conversation.
- **Supporting Evidence:** DP-pc-01 (`aiService.ts:228`, `'EX', 900`); `aiService.ts:4108` (`custom_model_id` resolves from cached config); `chatbotControlController.ts:31` (toggle never invalidates); findings-seed WF-B.
- **Disconfirming Evidence:** attenuated if edits are rare and single-worker deployments dominate, or `custom_model_id` is unused by these tenants.
- **Affected Files/Functions:** `backend/src/services/aiService.ts` (ai_config cache, locked-block self-heal), `controllers/chatbotControlController.ts`.
- **Real-World Impact:** mid-conversation persona/model drift and inconsistent guidelines (Issue-2), plus a second identical-input divergence source across workers (Issue-1).
- **Risk if unaddressed:** an admin tuning the AI sees non-uniform behaviour for up to 15 minutes; model drift can silently change cost/quality mid-thread.
- **Regression Prevention:** make every ai_config/toggle mutation path call `invalidateTenantAiCaches` (fix the toggle path) and shorten/version the cache key; test that a config edit is reflected on the next reply on all workers within one request; assert no two consecutive turns of one conversation resolve different `custom_model_id` for unchanged state.

---

#### RC-18 — Per-conversation rate counter INCRs per job ATTEMPT before gates, so retries/stale jobs exhaust the 25/h budget — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Pre-gate INCR verified (`processAIReply.ts:~1231` INCR precedes the `if (!aiConfig?.is_active)` gate at `:~1298`).
- **Root Cause:** the 25/h limiter INCRs once per job *attempt* before the enablement gates and the staleness guard, so BullMQ retries, stale-skipped jobs, disabled-AI jobs, and fairness/lock reschedules all burn budget without producing replies. A busy but legitimate conversation trips the cap on phantom increments and gets a persistent `ai_paused` + `rate_limit_exceeded` alert mid-thread.
- **Mechanism:** each `ai.reply` attempt → INCR → then gates/staleness may drop the job (no reply). Retries and self-reschedules multiply increments per real message. Count crosses 25 → `ai_paused=true` (manual unpause) + alert → AI silent for the rest of the hour and, via RC-14, beyond it.
- **Supporting Evidence:** DP-iq-21 (`processAIReply.ts:1231`, INCR before gates — arbiter-verified ordering), DP-GPR-05, `AI_MAX_REPLIES_PER_HOUR` live 25 (WF-G), couples with RC-14.
- **Disconfirming Evidence:** attenuated if retries/reschedules are rare so conversations never approach 25 genuine replies/hour.
- **Affected Files/Functions:** `backend/src/jobs/processAIReply.ts:1231`.
- **Real-World Impact:** legitimate active conversations pause mid-thread from phantom increments; couples with RC-14 into permanent silence.
- **Risk if unaddressed:** the busiest conversations (most retries, most fairness reschedules) are the most likely to be wrongly rate-paused.
- **Regression Prevention:** move the INCR to *after* the gates and staleness guard so only real, sent replies count; unit test asserting a stale-skipped/disabled/retried job does not increment the counter; integration test that N retries of one message consume one budget unit.

---

### Cross-cutting

---

#### RC-02 — Hallucination/gap guards validate the stochastic reply against the PER-TURN retrieval set, not the catalog — **CONFIRMED**

- **Severity:** Critical
- **Confidence:** High. author03 top-mechanism corroborated by dev DB — all 3 "hallucination" alerts (EV-011/013/015) are mechanical false positives against active catalog rows. Central mechanism spanning many DP rows; arbiter verified guards compare only to `matchedProducts` and that the name-guard escalates to a holding message.
- **Root Cause:** the price-hallucination filter, the product-name-hallucination filter, and the info-gap assessor all judge the generated reply against `matchedProducts` (the products retrieved for *this* turn), treating anything outside that ~10–25-item window as invented. Retrieval is per-turn, timing-sensitive, and keyword-dependent, so a factually correct answer about a real, active catalog item is stripped or **escalated to a canned holding message** whenever that item is not in the current window.
- **Mechanism:** `generateReply` retrieves for the current merged text → `matchedProducts`. Guards compare reply tokens/prices/names only to `matchedProducts`. A keyword-less follow-up ("po ai tjetri?") retrieves an unrelated set (or empties it), so a correct €18.00 (Carbo One Limon/Portokall, active rows) is flagged "hallucinated price," and a real active name the AI itself gave two turns earlier is flagged "hallucinated name" → the entire reply is replaced with `HOLDING_MESSAGES[...].productKnowledgeEscalation` and the turn is escalated + paused. *(Arbiter correction: the name-guard **escalates to a holding message**, it does not substitute a different product — see RC-12 refutation.)*
- **Supporting Evidence:** EV-011/013/015; DP-gg-31; `aiService.ts:3387` (name-guard early-return only when `matchedProducts.length===0`), `:4139` (`matchedProducts: usedFullCatalogFallback ? [] : products`); `jobs/processAIReply.ts:2857-2872` (`hasHallucination` → `finalReplyText = HOLDING_MESSAGES[...]` → escalate); findings-seed WF-B.
- **Runtime Evidence:** all three dev "hallucination" alerts match active catalog rows; EV-043: with `-small`, only exact/near-dup vectors clear 0.65 while same-category neighbours (0.54–0.59) are filtered, so the retrieval window is narrow and volatile.
- **Disconfirming Evidence:** would refute if guards cross-checked the full catalog before flagging (they do not) or if EV-011/013/015 prices/names did not match active rows (they do). The name-guard *fails open* on its own transport error (`:3441`), which limits — but does not remove — the false-positive path (the false positives come from correct classification against a wrong reference set, not from guard errors).
- **Affected Files/Functions:** `backend/src/services/aiService.ts` (price + name filters, `matchedProducts` assembly), `productInformationGapService.ts`.
- **Real-World Impact:** converts correct answers to escalations (Issue-1) and, mid-conversation, escalates facts the AI stated correctly earlier (Issue-2). Root of the false-hallucination alert class.
- **Risk if unaddressed:** the guards meant to prevent hallucination are the largest source of false escalations, directly feeding RC-14's permanent-silence end-state.
- **Regression Prevention:** validate guards against the **full tenant catalog** (a per-tenant price/name lookup), not the per-turn window; automated check replaying the EV-011/013/015 conversations asserting zero hallucination flags on active-catalog facts, plus a property test that any product name/price present in the tenant catalog never triggers a hallucination flag regardless of the current retrieval window.

---

#### RC-19 — Single umbrella try/catch makes the entire pre-reply escalation subsystem fail-open as a unit — **CONFIRMED**

- **Severity:** High
- **Confidence:** High. Umbrella catch spanning the whole special-path block verified (`processAIReply.ts:1383` try … `:1942-1948` catch → `console.warn('...continuing normal flow')`).
- **Root Cause:** `processAIReply.ts` wraps the entire pre-reply special-path block (cancellation/refund, wrong-product, post-purchase, order-info-update, escalation detection) in one try/catch. Any throw inside — classifier transport error, DB error on alert/message/order writes, contact lookup — is downgraded to `console.warn` and execution "continues normal flow" into `generateReply`. The escalation subsystem is fail-open as a unit, and because the catch swallows the error, BullMQ never retries.
- **Mechanism:** "I want a refund" → `detectCancellationOrRefundIntent` has no internal transport catch → OpenAI 5xx/timeout throws → umbrella catch logs and continues → `generateReply` produces an ordinary sales reply → no alert, no pause, no order flag, no retry. The exact throw line determines which partial side effects (sent acks, order flags, pauses) survive, so identical failures at different lines yield different outcome classes.
- **Supporting Evidence:** DP-GPR-28 (`processAIReply.ts:1383-1948`, verified), DP-GPR-17 (`detectCancellationOrRefundIntent` no internal catch), DP-GPR-18/19 (partial side-effect survival), DP-GPR-27 (order mutated before precheck within the block).
- **Disconfirming Evidence:** none survived — the arbiter confirmed the catch continues to `generateReply` rather than re-throwing.
- **Affected Files/Functions:** `backend/src/jobs/processAIReply.ts:1383-1948` (umbrella try/catch).
- **Real-World Impact:** sensitive escalations (refund/cancellation/complaint) silently downgraded to normal replies on any transient error; partial side effects (delivered ack + normal reply; mutated order without audit) on mid-block throws. High business/compliance risk.
- **Risk if unaddressed:** a transient OpenAI blip during a refund demand produces a cheerful sales reply and no record — the exact scenario the escalation system exists to prevent.
- **Regression Prevention:** give each detector its own inner catch with an explicit fail-*closed*-to-escalate policy, and have the umbrella catch **re-throw** so BullMQ retries; fault-injection tests asserting that a thrown classifier error on a refund message results in escalate-or-retry, never a normal sales reply.

---

#### RC-20 — Pipeline non-idempotent on BullMQ retry — crash-after-send dead-letters on global UNIQUE or duplicates with fresh generation — **CONFIRMED**

- **Severity:** High
- **Confidence:** High. `external_message_id VARCHAR(255) NOT NULL UNIQUE` (global) verified in `012_create_messages.sql:5`; retry semantics code-confirmed (DP-po-09/10/11).
- **Root Cause:** outbound send happens before persist/side-effects, and retries re-run the whole job (generateReply + guards + alerts + analytics + rate-counter) with only text/image sends idempotency-marked. On FB/IG/Viber the retry's INSERT collides on the **global** UNIQUE `external_message_id` and dead-letters (killing alerts/analytics/billing/draft-order for an already-delivered reply); on WhatsApp (null send id → marker) the retry inserts a **second** row with a fresh `ai_uuid` and a new LLM generation differing from what the customer saw.
- **Mechanism:** `generateReply` → `sendMessage` (delivered) → crash before job ack. Retry re-runs the whole job. FB/IG/Viber: `external_message_id = graphMessageId` (real) → re-INSERT violates global UNIQUE → job fails, no S-66..S-73 side effects for a delivered reply. WhatsApp: `priorGraphMessageId` null → new `ai_uuid` → duplicate row whose content is the fresh temp-0.3 generation ≠ delivered text → duplicate alerts/analytics + DB diverges from reality.
- **Supporting Evidence:** DP-po-09 (`processAIReply.ts:3199`), DP-po-10 (`:3068`), DP-po-11 (`:3195`), C-47/C-114 (real harm = single-tenant crash-after-send), DP-iq-19; UNIQUE verified `db/migrations/012_create_messages.sql:5`.
- **Runtime Evidence:** ~79 retained failed BullMQ jobs in dev (WF-G) indicate retries do occur.
- **Disconfirming Evidence:** would refute if a pre-send idempotency marker guaranteed exactly-once side effects (it does not) or if crash-after-send were empirically absent.
- **Affected Files/Functions:** `backend/src/jobs/processAIReply.ts` (send/persist ordering, `external_message_id`), `db/models/message.ts` / `db/migrations/012_create_messages.sql` (UNIQUE).
- **Real-World Impact:** delivered replies lose their billing/alert/analytics/draft-order side effects (revenue + escalation loss) OR are duplicated with content the customer never saw. Reliability + billing-integrity defect.
- **Risk if unaddressed:** any worker crash between send and ack silently corrupts billing/analytics or fabricates a DB record diverging from what the customer received.
- **Regression Prevention:** persist a pre-send idempotency marker and make side effects exactly-once/keyed on it; make send+persist a single idempotent unit so a retry no-ops after delivery. Test: kill the worker after send, assert the retry produces exactly one message row (matching delivered text) and one set of side effects.

---

#### RC-21 — Message persisted but ai.reply job never created — artifact-free permanent silence — **CONFIRMED**

- **Severity:** High
- **Confidence:** High. Early-return-on-retry + enqueue-after-ACK code-confirmed (DP-iq-15, DP-iq-04); arbiter verified persist → `existingJob.remove()` → `aiQueue.add` ordering in `processInboundMessage.ts`.
- **Root Cause:** if any throw occurs after the message row persists but before `aiQueue.add` succeeds — the debounce `existingJob.remove()` racing an active job, or a Redis failure in `getJobs`/`add` — the webhook job fails; on retry the global dedupe finds the persisted row and returns early, so the `ai.reply` job is never created. The message is stored and inbox-visible but the AI never processes it. A parallel path: `enqueueInboundPayload` runs after `res.sendStatus(200)`, so an enqueue failure is only `console.error`'d and the platform never redelivers.
- **Mechanism:** persist message → `existingJob.remove()` then `aiQueue.add` → throws (race/Redis). Job fails → retry → global dedupe finds the row → "Duplicate external_message_id, skipping" → returns before enqueue → no `ai.reply` ever. OR: webhook ACKs 200 then `void enqueueInboundPayload()` fails → logged only, no redelivery, `webhook_seen` already marks it seen 24h → lost.
- **Supporting Evidence:** DP-iq-15 (`processInboundMessage.ts:893`, verified: persist precedes remove+add), DP-iq-04 (`webhookController.ts:336`, enqueue after ACK), Phase 5 dead-end SILENT-ACTIVE, findings-seed WF-B headliner.
- **Disconfirming Evidence:** would refute if enqueue were transactional with persist, or the dedupe re-checked for a missing `ai.reply` job before early-returning (it does not).
- **Affected Files/Functions:** `backend/src/jobs/processInboundMessage.ts:893`, `controllers/webhookController.ts:336`, `db/models/message.ts` (global dedupe).
- **Real-World Impact:** a stored customer message gets no reply, ever, with no error artifact the merchant can see — a silent, unrecoverable drop. Feeds correct-early-then-silent (Issue-2) and answer-vs-silence (Issue-1).
- **Risk if unaddressed:** Redis blips or debounce races silently swallow customer messages with zero observability.
- **Regression Prevention:** make persist+enqueue a single retried unit, and have the dedupe re-check for the existence of the `ai.reply` job (re-enqueue if missing) rather than early-returning on the row alone; fault-injection test that a thrown enqueue after persist results in a job on retry, not silence.

---

#### RC-04 — Whether semantic retrieval runs at all is a per-worker timing coin-flip — **WEAKENED**

- **Severity:** High (mechanism) → effectively Medium-High for Issue-1 magnitude
- **Confidence:** High on the code mechanism; **narrowed** on Issue-1 impact.
- **Narrowed claim:** the non-aborting `Promise.race(generateEmbedding, 5s timer)` + bare `catch → null` + a per-process FIFO cache that **never caches the timed-out text** is a real, code-confirmed reliability defect and a progressive-degradation vector under sustained OpenAI slowness (Issue-2). **However**, EV-043 shows that with `text-embedding-3-small` the semantic arm rarely clears the 0.65 threshold (same-category neighbours score 0.54–0.59 and are filtered), so dropping the semantic source frequently changes `matchedProducts` little — the "identical request → different retrieved set → different reply" Issue-1 magnitude is smaller than originally framed.
- **Root Cause:** `generateQueryEmbeddingWithTimeout` (`aiService.ts:648-666`) resolves `null` on a 5s timeout (`EMBEDDING_QUERY_TIMEOUT_MS=5000`) or any error and does not cache the timed-out query, so fusion silently runs lexical-only and the next identical query re-races.
- **Mechanism:** OpenAI >5s or 429/5xx → race resolves null → `semanticSkipped=true` → RRF runs without the 2.0-weight semantic source → different `matchedProducts` and different guard inputs; timed-out text never cached (self-amplifying); different workers hold different FIFO cache contents.
- **Supporting Evidence:** verified `aiService.ts:648-666` (race + bare catch + no-cache-on-null), `:614-645` (per-process 256-entry FIFO cache), `EMBEDDING_QUERY_TIMEOUT_MS` default 5000 (`:610-612`); DP-retrieval-01/03/23; EV-043 (vector arm rarely contributes with `-small`).
- **Runtime Evidence:** `EMBEDDING_QUERY_TIMEOUT_MS` live default 5000; `[retrieval] Semantic path skipped` log with `semanticSkipped:true`.
- **Disconfirming Evidence:** the impact-narrowing evidence (EV-043) is *why* this is weakened, not refuted — the mechanism holds; its Issue-1 blast radius is limited by the fact that the semantic arm is often not decisive at the current model/threshold.
- **Affected Files/Functions:** `backend/src/services/aiService.ts` (retrieval fusion, embedding race, per-process cache), `embeddingService.ts`.
- **Real-World Impact:** under sustained OpenAI embedding slowness, progressive retrieval degradation within a conversation (Issue-2); a smaller, model-dependent Issue-1 divergence.
- **Risk if unaddressed:** an OpenAI latency incident silently degrades retrieval fleet-wide with only a log line; also implicates the `-small` model choice (RC-adjacent) that makes the vector arm weak.
- **Regression Prevention:** cache timed-out queries (or make the timeout abort+retry with backoff), emit a `semanticSkipped` metric with an alert threshold, and add a test asserting an embedding timeout does not silently drop the semantic arm without observability; separately, re-evaluate the embedding model/threshold (EV-043) so the vector arm actually contributes.

---

#### RC-22 — Intent-detect/draft-order throw swallowed; commission evaluated NOW()-relative post-send behind a 7-conjunct gate — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Swallowed throw verified (`processAIReply.ts:3831` `catch → console.error('Intent detection or draft order failed')`); post-send NOW()-relative window code-confirmed.
- **Root Cause:** draft-order creation depends on (a) purchase-intent/order-signal detection whose throw is caught and swallowed at `:3831` (green job, no order, no alert), (b) a 7-conjunct gate (`intent>0.85` + product_name + phone + name + address + affirmation) where any single conjunct near its boundary flips order/no-order, and (c) a commission-window check evaluated at `NOW()` **after** send. So identical order-ready turns nondeterministically create-or-not an order, and identical orders are marked commissionable-or-not on human-reply timing at the evaluation instant.
- **Mechanism:** order-ready message → detect/classify/affirmation; any throw → caught at `:3831` → job green, no order, no alert (silent commission forfeiture). If it succeeds, the 7-conjunct gate + boundary noise decides order vs skip. If an order is created, `hasHumanParticipationInCurrentOrderWindow` evaluates a NOW()-relative session window post-send → a human reply near the instant flips `is_commissionable`/`commission_amount`.
- **Supporting Evidence:** DP-po-18 (`processAIReply.ts:3831`, verified swallow), DP-po-30 (7-conjunct gate), DP-po-28 (NOW()-relative commission window), CLAUDE.md (commission decided at draft-order creation).
- **Disconfirming Evidence:** would refute if the throw were retried (it is swallowed) or commission were computed from stored event timestamps (it uses NOW()).
- **Affected Files/Functions:** `backend/src/jobs/processAIReply.ts` (intent-detect catch, draft-order gate, commission window).
- **Real-World Impact:** non-deterministic order creation and commission attribution → revenue leakage and billing inconsistency for identical order-ready turns.
- **Risk if unaddressed:** the platform's revenue mechanism (5% AI-order commission) is itself nondeterministic and silently forfeits on transient errors.
- **Regression Prevention:** compute commission eligibility from stored, ordered event timestamps (not NOW()), and make intent-detect failures escalate/retry rather than swallow; test that identical order-ready transcripts yield the same order + commissionability across N runs, and that an injected intent-detect error does not silently drop the order.

---

#### RC-24 — Instagram/Facebook self-echo misclassified as a human agent reply — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Heuristic + Redis-TTL dependency verified (`webhookNormalizer.ts:92` `echoAppId == null → human`; `outboundEchoRegistry.ts:53` read `catch → false`).
- **Root Cause:** echo classification is a single heuristic (no `app_id` ⇒ human agent) backed by a Redis self-echo registry (TTL 600s) whose read errors return `false`. On Instagram, echoes carry no `app_id`, so any registry miss (Redis hiccup, key evicted, echo delayed >10min) falls through to `isHumanAgentEcho ⇒ true`: the platform's own AI reply is recorded as a human agent reply — setting sticky `human_replied` (disqualifies use-case billing) and a 10-minute hold (AI silenced), plus a phantom `sent_by:'human'` row.
- **Mechanism:** AI sends reply → IG echoes it with no `app_id` → lookup `selfEchoKey`; on miss/error returns false → classified human agent → `markConversationHumanReplied` (sticky) + `human_override_until` (+10min) + `human_reply_sent` analytics. Identical conversations diverge into "AI keeps replying" vs "AI silenced + billing disqualified" on Redis availability/timing.
- **Supporting Evidence:** DP-iq-11 (`outboundEchoRegistry.ts:53`, verified `catch → false`), DP-iq-12 (`webhookNormalizer.ts:92`, verified `echoAppId == null → true`), findings-seed WF-B.
- **Disconfirming Evidence:** attenuated if IG echoes reliably resolve within 600s and Redis is highly available; the code path is certain.
- **Affected Files/Functions:** `backend/src/services/outboundEchoRegistry.ts:53`, `services/webhookNormalizer.ts:92`, `jobs/processInboundMessage.ts` (echo handling).
- **Real-World Impact:** self-inflicted `human_replied` kills use-case fee billing and silences AI 10min (Issue-2); flips outcome class on identical conversations (Issue-1). Inverse defect: WhatsApp/Viber have **no** echo handling, so native human replies there never pause AI.
- **Risk if unaddressed:** a Redis blip converts the AI's own messages into fake human handoffs, silently zeroing billable use cases and pausing service.
- **Regression Prevention:** disambiguate self-echoes by a durable signal (persisted outbound message id / content hash), not a TTL'd best-effort cache with fail-to-human; unit test that a registry miss on a known self-echo does not classify as human; add echo handling for WhatsApp/Viber. Assert `human_replied` is never set by an outbound the platform itself sent.

---

#### RC-25 — Albanian/Gheg dialect capability gap; business-rule footer reaches 1 of 6 tenants — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** High. WF-E verified (Albanian score 54/100) with a concrete EV-010 misfire.
- **Root Cause:** language handling is standard-Albanian-biased and English-classifier-driven: dialect/cue regexes (deictic lists, `RECOMMENDATION_COMPARISON_PATTERNS`) omit Kosovo/Gheg forms, embedding input is not normalized while lexical paths strip diacritics, and all classifier system prompts are English while judging Albanian text. On top, the restrictions footer carrying business rules is delivered to only **1 of 6** tenants (`platform_restrictions` is never rendered), so most tenants run without the business rules in-prompt.
- **Mechanism:** Gheg "A keni ma shum a veq aito" slips every dialect regex → falls to the English-prompted gap assessor → escalates `missing_info:['ma shum']` ("more" reported as an unavailable product attribute, alert d3db5dac). `%shije%` substring matches ~18% (46/257) of a catalog by name → wrong lexical hits. Missing footer → the guardrails R6/R13/R16/R17 mandate aren't in the prompt → guards escalate exactly the honest-negative/comparison/recommendation replies the rules would allow.
- **Supporting Evidence:** WF-E (Albanian 54/100); EV-010 (alert d3db5dac, `missing_info=['ma shum']`); `buildRestrictionsFooter` (footer to 1/6 tenants; `platform_restrictions` never rendered); WF-E (`%shije%` matches 46/257; embedding input not normalized; all-English classifier prompts).
- **Disconfirming Evidence:** would refute if `platform_restrictions` were rendered for the other 5 tenants via an unexamined path, or if real traffic were predominantly standard Albanian/English.
- **Affected Files/Functions:** `backend/src/services/productInformationGapService.ts` (English prompt), dialect/cue regexes (`webhookNormalizer`/`attributeIntent`/recommendation patterns), `aiService.ts` `buildRestrictionsFooter`.
- **Real-World Impact:** systematic misclassification/escalation of Gheg/Kosovo-dialect messages (the core market) and most tenants running without business rules → wrong-answer/escalate divergence (Issue-1) and dialect-thread degradation (Issue-2).
- **Risk if unaddressed:** the platform underperforms most in its stated primary market (Albanian-speaking Kosovo businesses).
- **Regression Prevention:** Albanian+Gheg evaluation corpus asserting correct classification/no-false-escalation on dialect messages; normalize embedding + lexical input consistently; render the business-rule footer for all tenants (fix `platform_restrictions`) with a test asserting 6/6 tenants receive it. Dialect classification is a discrete label — checkable without a judge; reserve LLM-as-judge for fluency of the generated Albanian reply.

---

#### RC-26 — Prompt-assembly defects: orphan offers_promotions block + unbudgeted system prompt contradicting guards — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** Medium-High. Orphan block verified in live DB; prompt-size and rule-conflict counts verified in WF-F/Phase 7.
- **Root Cause:** the assembled system prompt has structural defects independent of retrieval: an admin-created `offers_promotions` tenant_prompt_block (catalog-inactive, not in migrations) is enabled for 6/6 tenants and injects ~1478 chars referencing a nonexistent "Active offers" section into every prompt; the system prompt is unbudgeted (~26–33K chars / 6.5–8.3K tokens while only history is token-budgeted at 6000); and 5 in-prompt rules are actively contradicted by the guards (escalations fire on the exact honest-negative/comparison/recommendation replies R6/R13/R16/R17 mandate).
- **Mechanism:** every reply builds the prompt from tenant_prompt_blocks + ai_configs. The orphan block tells the model to reference offers the code never populates → invented/confused offer talk. Guidelines (17,907 chars) + always-on appends (SHORTEST_ANSWER 2397, PRODUCT_DESCRIPTION_CONCISE 1813) push the unbudgeted prompt to 26–33K chars, competing with the 6000-token history budget. Rules telling the AI to give honest negatives are contradicted by guards that escalate those replies.
- **Supporting Evidence:** prompt mapper (orphan `offers_promotions` ~1478 chars; 13 live blocks vs 12 in migrations); Phase 7 (business.md 17 rules; 5 contradicted by guards per EV-010/011/012; 7 in-prompt conflicts); findings-seed (system prompt ~26–33K chars, history-only budget 6000, system prompt unbudgeted).
- **Disconfirming Evidence:** would refute if the offers block were disabled at render time (it is enabled for 6/6) or if the rule/guard contradictions were reconciled by a precedence mechanism (none found).
- **Affected Files/Functions:** `tenant_prompt_blocks` (offers_promotions orphan), `backend/src/services/aiService.ts` (prompt assembly, always-on appends), `prompt_blocks` catalog.
- **Real-World Impact:** phantom-offer confusion and rule/guard contradictions degrade reply quality across all tenants; the unbudgeted prompt competes with history for attention (worse with depth → Issue-2).
- **Risk if unaddressed:** every tenant's every reply carries a self-contradictory, phantom-offer-laden prompt.
- **Regression Prevention:** remove the orphan block (migration + render-time allowlist of known blocks), token-budget the system prompt, and reconcile the R6/R13/R16/R17 rules with the guards (single source of truth). Test: assert the assembled prompt references no section the code does not populate, and that a rule mandating an honest negative is not escalated by a guard on the same input.

---

#### RC-09 — Channel/tenant resolution by (type, external_id), LIMIT 1, no tenant scope, no ORDER BY — **WEAKENED**

- **Severity:** High (as an isolation defect) → latent (not runtime-observed)
- **Confidence:** Medium. Code-confirmed isolation defect (SEC-2/C-115); **dormant** in dev (channels table has 0 rows), so not runtime-verified.
- **Narrowed claim:** `findChannelByTypeAndExternalId` (`channel.ts:120`) resolves the owning tenant with `WHERE type=$1 AND external_id=$2 LIMIT 1` — **no tenant filter, no ORDER BY** (arbiter-verified) — and the `channels` UNIQUE key is `(tenant_id, type, external_id)`, which *permits* the same external account under two tenants with no global guard. This is a genuine latent multi-tenant isolation defect. **But** dev has 0 channel rows and there is no evidence any external account is actually dual-connected, so the runtime "identical webhook → different tenant → different reply" divergence is **latent/hypothetical, not observed**. The claim is retained as a code-confirmed isolation risk, downgraded from a demonstrated Issue-1 driver.
- **Mechanism:** webhook (no JWT) → resolve channel by `(type, external_id)` → `LIMIT 1` returns an arbitrary of N matching rows (heap/planner order) → tenant A vs B nondeterministically → different products/ai_config/prompt blocks/custom_model_id → different reply. Also a cross-tenant data-placement defect.
- **Supporting Evidence:** C-115/SEC-2; DP-iq-07; arbiter-verified `db/models/channel.ts:118-124` (unscoped `LIMIT 1`, no ORDER BY); `channels` UNIQUE includes `tenant_id` (no global guard); WF-G: channels table empty ⇒ code-only.
- **Disconfirming Evidence:** would refute if an application/operational guarantee prevents the same `external_id` under two tenants (e.g. onboarding enforces global uniqueness) — none found in code, but N>1 is unproven live.
- **Affected Files/Functions:** `backend/src/db/models/channel.ts:120`, `jobs/processInboundMessage.ts:485`.
- **Real-World Impact:** *if* an account is ever dual-connected, identical webhooks route to different tenants (Issue-1) — a genuine cross-tenant message-routing/isolation defect. No dev evidence it has occurred.
- **Risk if unaddressed:** a latent security/isolation landmine that becomes an active cross-tenant leak the moment two tenants connect the same account (or a shared test account is reused).
- **Regression Prevention:** add a global UNIQUE on `(type, external_id)` (or an explicit onboarding guard) so dual-connect is impossible, and make the resolver deterministic; test rejecting a second tenant connecting an already-connected external account, and asserting webhook resolution is single-valued.

---

#### RC-23 — CI/CD and migration reliability gaps — deploy races CI, npm test never runs, duplicate/non-atomic migrations out of order — **CONFIRMED**

- **Severity:** Medium
- **Confidence:** High. Arbiter-verified: `deploy.yml` deploy-staging triggers on `push` to `main` with no CI gate (separate workflow, no `needs:`/`workflow_run`); `ci.yml` runs `typecheck`+`build`+migration/health but **no `npm test`**.
- **Root Cause:** the delivery pipeline provides no safety net for the AI defects above. `deploy.yml` deploy-staging fires on push-to-main (`if: github.event_name=='push' && github.ref=='refs/heads/main'`) with no CI dependency, so it deploys concurrently with or before tests. `ci.yml` has no `npm test` step (548 green tests never execute; smoke uses placeholder keys, health-only). `migrate.ts` applies files by lexicographic `.sort()` with per-file BEGIN/COMMIT (not atomic across files), no `pg_advisory_lock`, no down migrations, with duplicate 062–065 files applied out of numeric order (065_offers before 063_catalog_grounding).
- **Mechanism:** push to main → staging deploys immediately, unblocked by CI → a regression a test would catch ships. CI green never means "tests passed." Migrations tracked by filename not number → ordering surprises and no atomicity → partial schema on failure. This is the reliability substrate that lets RC-01..RC-22 reach production unnoticed.
- **Supporting Evidence:** arbiter-verified `.github/workflows/ci.yml` (jobs run `npm run typecheck`/`npm run build`, Postgres/Redis health services, no `npm test`) and `.github/workflows/deploy.yml:1-35` (push-to-main trigger, no CI gate); C-48/C-150/C-151 (duplicate 062, lexicographic sort, per-file BEGIN/COMMIT, no advisory lock).
- **Runtime Evidence:** `npm test` 548 pass/75 suites offline (WF-G), CI never runs them; ~79 retained failed BullMQ jobs incl. `offerEmbeddingReconcileFast` failing ~every run.
- **Disconfirming Evidence:** would refute if a branch-protection/required-check rule outside these workflow files gated deploy on CI, or `npm test` ran in an uninspected job — neither found.
- **Affected Files/Functions:** `.github/workflows/deploy.yml`, `.github/workflows/ci.yml`, `backend/src/db/migrate.ts`, `backend/src/db/migrations/` (062–065 duplicates).
- **Real-World Impact:** no automated catch for the AI/reliability regressions above; migration ordering/atomicity hazards. Systemic quality-gate failure enabling every other root cause to ship.
- **Risk if unaddressed:** every fix for RC-01..RC-26 can silently regress with no gate; a failed migration can leave a partial schema.
- **Regression Prevention:** gate deploy on CI success (`needs:`/`workflow_run` or required status checks), add `npm test` to CI, number-order migrations with an advisory lock and cross-file atomicity, and de-duplicate 062–065. These are objective, statically checkable pipeline invariants.

---

## Verification summary

Verifier verdicts were not delivered to the arbiter (see arbiter note above); the "Verifier verdicts" column records the arbiter's own first-hand source re-verification standing in for the blind pass. Disposition is the arbiter's final ruling.

| ID | Title (short) | Issue | Sev | Verifier verdicts | Final disposition |
|----|---------------|-------|-----|-------------------|-------------------|
| RC-01 | Fail-closed non-deterministic gap-escalation gate | 1 | Critical | Arbiter re-verified source + live-replay | **CONFIRMED** |
| RC-02 | Guards judge reply vs per-turn window, not catalog | cross | Critical | Arbiter re-verified (name-guard→holding msg) | **CONFIRMED** |
| RC-03 | Reply temp 0.3, no seed → divergent/fabricating | 1 | High | Arbiter re-verified default 0.3 | **CONFIRMED** |
| RC-05 | 8s-debounce burst merge/split/stale coin-flip | 1 | High | Arbiter re-verified debounce | **CONFIRMED** |
| RC-06 | Gates/knobs read at run-time ≥8s after receipt | 1 | Medium | Arbiter re-verified | **CONFIRMED** |
| RC-07 | Confidence-boost asymmetry escalate vs order | 1 | Medium | Arbiter re-verified boost sites | **CONFIRMED** |
| RC-08 | Routing on fixed boundaries over noisy scores | 1 | Medium | Confirmed (inherent + thresholds verified) | **CONFIRMED** |
| RC-09 | Channel resolve unscoped LIMIT 1, no ORDER BY | 1 | High | Arbiter re-verified code; dormant in dev | **WEAKENED** |
| RC-10 | Language decided by temp-0 LLM, hard 'sq' default | 1 | Medium | Confirmed fallback chain | **CONFIRMED** |
| RC-11 | Webhook Date.now() fallback + 300s skew 403 | 1 | Medium | Confirmed | **CONFIRMED** |
| RC-13 | 40-row window + lost product_ids anchor | 2 | High | Confirmed (Q3 + LIMIT 40) | **CONFIRMED** |
| RC-14 | No AI auto-resume — pause = permanent silence | 2 | High | Arbiter re-verified no-resume path | **CONFIRMED** |
| RC-15 | Depth quality decline + eval false-low + thr 0.1 | 2 | Medium | Threshold/eval confirmed; decline correlational | **WEAKENED** |
| RC-16 | History re-feeds flagged/undelivered as assistant | 2 | Medium | Arbiter re-verified role mapping | **CONFIRMED** |
| RC-17 | 900s delete-only ai_config cache → persona/model drift | 2 | Medium | Arbiter re-verified EX 900 + model in cache | **CONFIRMED** |
| RC-18 | Rate INCR before gates → phantom pause | 2 | Medium | Arbiter re-verified INCR-before-gate ordering | **CONFIRMED** |
| RC-19 | Umbrella catch → escalation subsystem fail-open | cross | High | Arbiter re-verified catch scope | **CONFIRMED** |
| RC-20 | Non-idempotent retry: dead-letter or dup gen | cross | High | Arbiter re-verified global UNIQUE | **CONFIRMED** |
| RC-21 | Persist-then-no-enqueue → artifact-free silence | 2 | High | Arbiter re-verified ordering + dedupe | **CONFIRMED** |
| RC-22 | Intent throw swallowed; NOW()-relative commission | cross | Medium | Arbiter re-verified swallow | **CONFIRMED** |
| RC-04 | Semantic-retrieval 5s race coin-flip | cross | High | Mechanism confirmed; Issue-1 magnitude narrowed (EV-043) | **WEAKENED** |
| RC-24 | IG self-echo misclassified as human agent | cross | Medium | Arbiter re-verified heuristic + catch→false | **CONFIRMED** |
| RC-25 | Albanian/Gheg gap + footer to 1/6 tenants | cross | Medium | Confirmed (WF-E + EV-010) | **CONFIRMED** |
| RC-26 | Orphan offers block + unbudgeted contradictory prompt | cross | Medium | Confirmed (live DB + Phase 7) | **CONFIRMED** |
| RC-23 | CI races deploy, npm test never runs, migration order | cross | Medium | Arbiter re-verified ci.yml/deploy.yml | **CONFIRMED** |
| RC-12 | Name-guard "replaces with rotated-window product" | 2 | (High) | **Refuted by source** — guard escalates to holding msg, never substitutes a product; fails open | **REFUTED → appendix B** |

**Counts.** 26 candidates → **22 CONFIRMED**, **3 WEAKENED** (RC-04, RC-09, RC-15), **1 REFUTED** (RC-12). Surviving in the main ledger: **25**. By issue among survivors: **Issue-1 primary = 9** (RC-01, RC-03, RC-05, RC-06, RC-07, RC-08, RC-09, RC-10, RC-11), **Issue-2 primary = 7** (RC-13, RC-14, RC-15, RC-16, RC-17, RC-18, RC-21), **cross-cutting = 9** (RC-02, RC-04, RC-19, RC-20, RC-22, RC-23, RC-24, RC-25, RC-26). Severity among survivors: **2 Critical** (RC-01, RC-02), **8 High**, **15 Medium**.

**Top confirmed driver — Issue 1:** RC-01 (fail-closed non-deterministic product-info-gap escalation gate). **Top confirmed driver — Issue 2:** RC-14 (no AI auto-resume — every escalation-triggered pause becomes permanent silence).
