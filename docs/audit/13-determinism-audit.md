# Phase 13 — Determinism Audit (Nondeterminism Inventory)

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts) and live-replay experiments (Phase 10, small-N). Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md for verbatim query evidence.

This phase re-reads the deduplicated Decision Point Register (160 rows, `scratchpad/audit/register/merged.json`; summarized in `03-divergence-analysis.md`) through a single lens: **which decision points are genuinely nondeterministic** — i.e., two executions of the same logical input can diverge at or through the row itself — and which are merely **deterministic but fragile** (pure functions of their direct inputs whose badness is a static design weakness, not run-to-run variance).

**Classification rule used.** A row belongs to the nondeterminism inventory if its own divergence story requires any of: LLM sampling or provider-side non-bit-determinism, a race or timing window, cache phase, scheduler/worker affinity, nondeterministic storage/ANN ordering, infrastructure failure occurrence, or state that accumulates nondeterministically between executions of the same conversation. A row is *deterministic but fragile* if — holding its direct inputs and state fixed — repeated executions always produce the same outcome; these rows amplify upstream variance or degrade silently, but inject no variance of their own. **Result: 151 rows in the nondeterminism inventory, 9 deterministic-but-fragile rows.**

Conventions: step ids (S-01…S-74) refer to `02-execution-trace.md`; outcome classes (**correct / wrong / escalate / silence**) and [E-nn] exit ids refer to `03-divergence-analysis.md`; file paths are relative to `backend/src/`, line numbers per commit `a8ceb15`. Merged register rows keep their survivor id (absorption map in `03-divergence-analysis.md`). For each row below:

- **Mechanism** — how the nondeterminism enters
- **Manifests when** — triggering conditions
- **Impact** — observable effect on output quality (outcome classes it can produce)
- **Determinism achievable** — yes / partially / no at this pipeline stage, classification-level only (concrete implementation is Phase 16 scope)
- **Management** — eliminate / bound / detect+log / accept
- **Confirmed root cause** — the Phase 11 root-cause id(s) (`11-root-causes.md`, confirmed/weakened ledger) this row rolls up into, mapped by shared DP-id citation or by mechanism. A row that no confirmed root cause covers (its hypothesis was refuted or narrowed away in Phase 11) is marked *not elevated to a root cause — see appendix B* rather than dropped.

> **Cross-link provenance.** The 22 confirmed + 3 weakened survivors (RC-01…RC-26, minus the refuted RC-12) are the ledger in `11-root-causes.md`. Root-cause ids used below all exist in that ledger. RC-14 (no AI auto-resume) and RC-23 (CI/CD gate gap) are **not** cross-linked from any inventory row: RC-14 is a deterministic amplifier (a paused conversation stays paused every run — it injects no variance of its own, it only makes upstream variance terminal), and RC-23 is a delivery-pipeline gap with no runtime decision point. Both still appear in the severity bridge below with that status called out.

---

## Nondeterminism inventory

### Class 1 — LLM-stochastic (42 rows)

The single largest class. One root (DP-gg-01) is irreducible; the remaining rows are classifier gates, guard verdicts, and extraction steps whose *verdicts* cannot be made deterministic but whose *decision structure* (thresholds, persistence, retry reuse, failure policy) can be.

#### DP-GPR-14 — Reply-language decision (S-22 · `services/aiService.ts:1837`)
- **Mechanism:** When marker heuristics cannot resolve language, a temp-0 LLM call (low-variance but still stochastic, model-version dependent) decides the language of the entire reply including every canned message; transport error falls back to heuristics and ultimately hard-defaults to `sq`.
- **Manifests when:** Inbound text without unambiguous sq/en markers, or OpenAI transport error.
- **Impact:** Same ambiguous message answered in Albanian on one run, English on another — including canned order confirmations (correct/wrong).
- **Determinism achievable:** Partially — the verdict can be persisted per conversation/message and reused, removing re-detection flips; first-detection variance on ambiguous text remains.
- **Management:** bound (persist + hysteresis on language switching).
- **Confirmed root cause:** RC-10 (temp-0 language decision), RC-25 (English-classifier / dialect gap)

#### DP-GPR-15 — Cancellation/refund routing gate (S-23 · `jobs/processAIReply.ts:1389`)
- **Mechanism:** Temp-0 JSON classifier acting at `confidence > 0.8`; borderline messages (policy questions, hypotheticals) sit on the boundary.
- **Manifests when:** Ambiguous cancellation/refund phrasing near the 0.8 gate.
- **Impact:** Maximally divergent outcome classes: canned ack + order flag + alert + AI pause vs a normal sales reply (correct/wrong/escalate).
- **Determinism achievable:** Partially — verdict persistence per message eliminates retry re-rolls; boundary variance on first evaluation is irreducible.
- **Management:** bound (threshold hysteresis, persisted verdicts, human review of boundary band).
- **Confirmed root cause:** RC-08 (0.8 confidence boundary), RC-19 (pre-reply umbrella fail-open)

#### DP-GPR-16 — Missing-confidence boost quirk (S-23 · `services/aiService.ts:2509`)
- **Mechanism:** If the model asserts `is_cancellation`/`is_refund` but omits/zeroes `confidence`, code overwrites it to 0.9, guaranteeing gate passage; sibling boosts at 2584-2586 (0.9), 2686-2688 (0.9), 2888 (0.85) — while `detectOrderAffirmationIntent` has no boost and fails its gate on the same quirk.
- **Manifests when:** Model returns intent booleans with a missing/zero confidence field.
- **Impact:** A malformed-but-parseable response that would fail the gate instead triggers full escalation; asymmetric handling of the identical model quirk across detectors (correct/escalate).
- **Determinism achievable:** Yes — the boost is a code policy, not a model property; a uniform missing-confidence rule makes the mapping from model output to decision deterministic.
- **Management:** eliminate (uniform missing-confidence policy across all detectors).
- **Confirmed root cause:** RC-07 (confidence-boost asymmetry)

#### DP-GPR-20 — Wrong-product routing (S-24 · `jobs/processAIReply.ts:1507`)
- **Mechanism:** Temp-0 classifier at `confidence > 0.8` (with the 0→0.9 boost); quality/damage complaints vs wrong-item are exactly the enumerated boundary cases.
- **Manifests when:** Complaint phrasing near the wrong-item/quality boundary.
- **Impact:** AI paused + `human_replied` force-reset to false (billing-relevant) + alert + holding message vs a normal reply (correct/wrong/escalate).
- **Determinism achievable:** Partially — persistence/hysteresis removes re-roll variance; first-pass boundary flips remain.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (confidence boundary), RC-07 (0→0.9 boost)

#### DP-GPR-22 — New-order / affirmation vetoes (S-25 · `jobs/processAIReply.ts:1595`)
- **Mechanism:** Two temp-0 verdicts (`classifyNewOrderSignal`, keyword fallback on error; `detectOrderAffirmationIntent` at the >0.7 knife-edge, no boost) veto whether post-purchase, delivery-ETA, and order-info-update branches run at all.
- **Manifests when:** Messages mixing affirmation/new-order phrasing with complaint or info-update phrasing; or classifier transport error swapping in keyword matching.
- **Impact:** Identical message rerouted between escalation, canned ETA reply, direct order mutation, and plain generation (correct/wrong/escalate).
- **Determinism achievable:** Partially — the veto structure and failure fallback can be made uniform and persisted; verdict variance remains.
- **Management:** bound.
- **Confirmed root cause:** RC-07 (affirmation lacks boost), RC-08 (confidence boundary)

#### DP-GPR-24 — Post-purchase support classifier (S-26 · `jobs/processAIReply.ts:1634`)
- **Mechanism:** Behind a deterministic regex cue, a four-boolean-flag classifier at `confidence > 0.8` (with 0→0.9 boost) selects between ETA-only auto-reply, full escalation, or fall-through to generation; parse failure returns all-false and silently falls through.
- **Manifests when:** Post-purchase-cue message with phrasing near flag/confidence boundaries.
- **Impact:** "Where is my package?" flips outcome class between executions (correct/wrong/escalate).
- **Determinism achievable:** Partially — same as its siblings: structure yes, verdict no.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (confidence boundary), RC-07 (0→0.9 boost)

#### DP-GPR-25 — Delivery-ETA-only trilemma (S-27 · `jobs/processAIReply.ts:1642`)
- **Mechanism:** `isDeliveryEtaOnlyQuery` mixes an LLM eta-flag AND three complaint-flag negations (conf>0.8) OR a regex cue; NULL `tenant.delivery_time` falls through to escalation where the same eta-flag alone triggers pause+alert.
- **Manifests when:** ETA-flavored message where the regex cue misses and LLM flags fluctuate.
- **Impact:** One stochastic flag separates instant canned answer from AI-paused-pending-human (correct/escalate/silence).
- **Determinism achievable:** Partially — the NULL-delivery_time branch asymmetry is deterministic and fixable; flag variance remains.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (confidence boundary)

#### DP-GPR-26 — Order-info-update trigger + values (S-29 · `jobs/processAIReply.ts:1818`)
- **Mechanism:** Fires at `confidence > 0.82` (0→0.85 boost) and directly UPDATEs the latest active order's customer fields with LLM-extracted values — both the trigger and the written data are model outputs; internal catch returns all-false and silently skips.
- **Manifests when:** Message resembling contact/address info while a conversation-scoped active order exists.
- **Impact:** Two executions disagree on whether to mutate the order and on what values are written (correct/wrong).
- **Determinism achievable:** Partially — extraction can be validated/normalized deterministically and persisted; the extraction itself is stochastic.
- **Management:** bound (validated writes + the existing `order_info_updated` audit alert as detection).
- **Confirmed root cause:** RC-07 (0→0.85 boost), RC-08 (confidence boundary)

#### DP-retrieval-04 — Embedding vector jitter at the threshold (S-35 · `services/aiService.ts:709`)
- **Mechanism:** The embeddings API is not bit-exact across calls; `SIMILARITY_THRESHOLD` (0.65) is a strict post-filter with no hysteresis, so a product scoring ~0.649–0.651 flips in/out of the highest-weighted (2.0) fusion source between cache-miss calls.
- **Manifests when:** Cache-miss embedding call plus at least one product within API jitter of the threshold.
- **Impact:** Top fused product reordered or removed → different reply (correct/wrong).
- **Determinism achievable:** Partially — shared/durable query-embedding caching makes repeats deterministic; first-computation jitter is provider-side and irreducible.
- **Management:** bound (cache + threshold hysteresis band).
- **Confirmed root cause:** RC-04 (semantic-retrieval nondeterminism / threshold jitter)

#### DP-retrieval-15 — Contextual follow-up classifier, fail-closed (S-36 · `services/aiService.ts:3722`)
- **Mechanism:** On the empty-retrieval safety net, an LLM classifier decides whether to reuse persisted products; it fails closed (false) when the LLM is unavailable.
- **Manifests when:** All retrieval paths empty, persisted ids present, follow-up phrasing outside the heuristic patterns (dialect, misspellings).
- **Impact:** The AI denies knowledge of products it recommended one turn earlier vs correctly reusing them (correct/wrong/escalate).
- **Determinism achievable:** Partially — heuristic-first with persisted verdicts narrows the stochastic surface; classifier variance on novel phrasing remains.
- **Management:** bound.
- **Confirmed root cause:** RC-13 (lost product_ids anchor)

#### DP-retrieval-16 — Retrieval mode selection (S-36 · `services/aiService.ts:3585`)
- **Mechanism:** Upstream classifier outputs (`is_attribute_question`, `is_other_options_request`) combined with regexes select the retrieval strategy AND flip the match limit between 25 and 10.
- **Manifests when:** Message near a classifier decision boundary (attribute vs new-search vs "other options").
- **Impact:** Which retrieval strategy runs and how many products enter the prompt both change on a verdict flip (correct/wrong).
- **Determinism achievable:** Partially — mode selection can be persisted per message; verdicts stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (borderline classifier flips retrieval mode)

#### DP-pc-16 — Classifier-gated prompt content (S-39 · `services/aiService.ts:3977`)
- **Mechanism:** Four classifier outputs (price, discount, attribute, other-options) deterministically toggle prompt content: per-product price lines, `PRICE_LIST_COMPACT_APPEND`, discount lines / `[NO_REPLY]` short-circuit, attribute and other-options appends; each fails open to keyword fallbacks.
- **Manifests when:** Borderline phrasing or classifier transport error flipping to keyword coverage.
- **Impact:** A prompt with prices vs one without → the model quotes, improvises, or refuses a price (correct/wrong/silence).
- **Determinism achievable:** Partially — content toggles can be made monotonic (always include prices, instruct usage) which removes the flip; classifier variance itself remains.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (classifier-gated prompt content), RC-26 (prompt assembly)

#### DP-pc-18 — Locale-driven guideline placeholders (S-39 · `services/promptAssemblyService.ts:81`)
- **Mechanism:** The detected reply locale (DP-GPR-14) drives the `{{TOKEN}}` placeholder map inside every guideline block and the closing-sentence choice; `SHARED_CONTENT_SYSTEM_APPEND` is Albanian-only regardless.
- **Manifests when:** Language-ambiguous inbound or language-classifier transport error.
- **Impact:** Materially different guideline sentences that downstream fixed-phrase guards then match against (correct/wrong).
- **Determinism achievable:** Partially — inherits DP-GPR-14; deterministic given a pinned locale.
- **Management:** bound (pin locale per conversation).
- **Confirmed root cause:** RC-10 (locale inheritance), RC-25 (Albanian-only append)

#### DP-pc-17 — Conversation-ending verdict (S-41 · `services/aiService.ts:4050`)
- **Mechanism:** `isConversationEnding` (LLM, catch → false) picks between closing-append, no append, and `[NO_REPLY]` silence — the silence branch additionally requires the previous assistant text to verbatim-match a known closing.
- **Manifests when:** Farewell-like inbound without "?"; prior closing rephrased by any guard breaks the match.
- **Impact:** Repeat goodbye, silent turn, or normal reply for the identical farewell (correct/wrong/silence).
- **Determinism achievable:** Partially — the verbatim-match dependence is eliminable (canonical closing marker); the ending verdict is stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (stochastic ending verdict flips outcome)

#### DP-gg-05 — [NO_REPLY] site 1: finalized discount (S-41 · `services/aiService.ts:3519`)
- **Mechanism:** When the `customerAskedDiscount` classifier fires AND a prior assistant message finalized the discount, generation is skipped entirely and `[NO_REPLY]` is returned.
- **Manifests when:** Discount-flavored message with `assistantAlreadyFinalizedDiscount` true; classifier verdict varies.
- **Impact:** Normal answer vs total silence on a classifier blip (correct/silence).
- **Determinism achievable:** Partially — the state check is deterministic; the routing classifier is not.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (classifier flip → [NO_REPLY] silence)

#### DP-gg-06 — [NO_REPLY] site 2: closing dedupe (S-42 · `services/aiService.ts:4066`)
- **Mechanism:** Ending verdict (fail-open to false) selects among silence (prior closing verbatim-matched), canned closing, or full generation; a transport error silently converts a should-be-silent turn into a fresh reply.
- **Manifests when:** Closing-like message; verdict or transport error varies.
- **Impact:** Bot repeats its goodbye vs stays silent vs generates (correct/wrong/silence).
- **Determinism achievable:** Partially — same decomposition as DP-pc-17.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (classifier flip → [NO_REPLY] silence)

#### DP-gg-01 — Core reply sampling (S-42 · `services/aiService.ts:4118`)
- **Mechanism:** The single customer-facing completion runs at temperature 0.3 (env `AI_REPLY_TEMPERATURE`) with no seed, no top_p, no response_format. **This is THE per-request stochastic root**: every downstream guard (price regex, name validator, health classifier, deflection regex, quality eval) operates on sampled text. Even at temperature 0, OpenAI completions are not bit-deterministic.
- **Manifests when:** Every request.
- **Impact:** All four outcome classes reachable from wording variance alone (correct/wrong/escalate/silence).
- **Determinism achievable:** No — provider-side non-bit-determinism cannot be configured away at this stage; only the *consequences* of variance can be managed downstream.
- **Management:** accept (and bound consequences via deterministic guard structure; record temperature/seed/model per message for auditability).
- **Confirmed root cause:** RC-03 (temp-0.3 sampling — THE per-request stochastic root)

#### DP-gg-03 — Vision-model switch + confidence-gated temperature clamp (S-42 · `services/aiService.ts:4113`)
- **Mechanism:** Image turns switch to `OPENAI_VISION_MODEL` (custom model ignored) and clamp temperature only when `productNotInCatalog || shouldAskImageClarification || imageMatchConfidence < 0.65` — all three inputs come from the stochastic vision pipeline.
- **Manifests when:** Vision-eligible attachment with match confidence near 0.65.
- **Impact:** Same photo scores 0.66 vs 0.64 across runs, flipping both temperature and clarify-vs-answer framing (correct/wrong).
- **Determinism achievable:** Partially — persisting the per-attachment confidence makes retries consistent; the vision extraction itself is stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-03 (sampling; confidence-gated vision temperature clamp)

#### DP-gg-07 — [NO_REPLY] sink skips all bookkeeping (S-43 · `jobs/processAIReply.ts:1983`)
- **Mechanism:** On `[NO_REPLY]` the job returns before guards, persist, quality eval, `ai_reply_sent` analytics, and the 4h `evaluateConversationUseCase` enqueue — so an upstream classifier blip changes the conversation's *billing class*, not just the reply.
- **Manifests when:** Either aiService `[NO_REPLY]` site fires.
- **Impact:** Whether the conversation ever becomes a billable use case hinges on a stochastic verdict (silence + billing divergence).
- **Determinism achievable:** Yes — bookkeeping (analytics + use-case eval enqueue) can be made unconditional on the reply path, decoupling billing determinism from reply stochasticity.
- **Management:** eliminate (unconditional bookkeeping).
- **Confirmed root cause:** RC-22 (billing-class divergence from a stochastic verdict)

#### DP-gg-08 — Out-of-stock exact-string exemption (S-44 · `jobs/processAIReply.ts:1989`)
- **Mechanism:** OOS exemption is an exact string match of the stochastic reply against `OUT_OF_STOCK_PRODUCT_REPLY.sq/.en`; verbatim reproduction exempts the reply from all guards and grants synthetic quality 0.95, one-character paraphrase gets fully guarded.
- **Manifests when:** Out-of-stock replies; verbatim-vs-paraphrase variance.
- **Impact:** Guard-exempt vs fully-guarded path for the same fact (correct/escalate).
- **Determinism achievable:** Yes — emit the canned OOS reply from code (deterministic path marker) instead of hoping the model reproduces it.
- **Management:** eliminate (canonical canned-reply path).
- **Confirmed root cause:** RC-02 (guard-suite self-exemption), RC-03 (verbatim-vs-paraphrase sampling)

#### DP-gg-09 — Usage-question master gate (S-45 · `jobs/processAIReply.ts:2004`)
- **Mechanism:** `classifyUsageQuestionIntent` (LLM temp 0, keyword fallback on error) gates usage-guard variants A/B/C and the speculative-health guard; transport error swaps in a keyword heuristic with different coverage.
- **Manifests when:** Usage/suitability-flavored message; verdict variance or OpenAI error.
- **Impact:** The whole usage-escalation family toggles on/off (correct/escalate).
- **Determinism achievable:** Partially — uniform failure fallback and persisted verdicts; verdict variance remains.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (classifier gates the whole usage-escalation family)

#### DP-gg-10 — Verbatim-usage exemption (S-45 · `jobs/processAIReply.ts:2001`)
- **Mechanism:** Variant A is skipped only when the reply is a normalized-verbatim copy of `usage_description` — the stochastic reply decides its own guard exposure.
- **Manifests when:** Matched product has a usage_description; model paraphrases instead of quoting.
- **Impact:** Answer vs holding message on identical catalog data, purely on wording (correct/escalate).
- **Determinism achievable:** Partially — a deterministic quote-injection path would remove the flip, but as long as the model may paraphrase, exposure varies.
- **Management:** bound.
- **Confirmed root cause:** RC-02 (reply self-exempts from guard), RC-03 (paraphrase variance)

#### DP-gg-11 — Three inconsistent failure surfaces in `isUsageQuestionUnanswered` (S-45 · `jobs/processAIReply.ts:2018`)
- **Mechanism:** The prompt says fail-closed ("WHEN IN DOUBT → is_unanswered: true"), the function code returns false on unparseable output, and the caller's catch fails open — three outcome classes from one check depending on *how* it fails.
- **Manifests when:** Variant A triggered; borderline verdict, parse failure, or transport error.
- **Impact:** Escalate vs answer vs answer — divergence by failure mode, not content (correct/wrong/escalate).
- **Determinism achievable:** Yes — aligning the three failure surfaces to one policy makes the failure-time behavior deterministic (the underlying verdict stays stochastic, tracked by DP-gg-09/10).
- **Management:** eliminate (single consistent failure policy).
- **Confirmed root cause:** RC-01 (fail-closed prompt vs fail-open caller — inconsistent escalation surfaces)

#### DP-gg-13 — Self-authored holding text, alert suppressed (S-47 · `jobs/processAIReply.ts:2117`)
- **Mechanism:** Variant C fires when the model itself stochastically writes specialist-escalation wording (fuzzy match); if the re-run classifier then errors, the customer still receives "a specialist will contact you" while no alert is created and AI stays active.
- **Manifests when:** Model spontaneously produces holding-like wording; classifier error/"answered" verdict suppresses the alert.
- **Impact:** A promise with nobody notified (escalate/wrong).
- **Determinism achievable:** Partially — coupling the promise to the alert (send holding only when the alert commit succeeded) removes the orphan-promise branch; the trigger is stochastic.
- **Management:** detect+log (holding-like outbound without a matching ai_alerts row is a detectable invariant violation).
- **Confirmed root cause:** RC-03 (model self-authors escalation wording), RC-02 (guard/alert coupling)

#### DP-gg-15 — Gap assessor trilemma (S-48 · `jobs/processAIReply.ts:2416`)
- **Mechanism:** The assessor's temp-0 JSON (`answer` + `missing[]`) drives complete → untouched reply, partial → reply replaced by `composePartialAnswer`, none → holding message; one borderline `missing` label flips the customer-visible text.
- **Manifests when:** Gap guard reached; assessor output near the answered/missing boundary.
- **Impact:** Three different texts for identical catalog knowledge (correct/escalate).
- **Determinism achievable:** Partially — deterministic post-validation of `missing` against structured catalog fields narrows the band; assessment is stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-01 (gap assessor), RC-02 (judged vs per-turn window)

#### DP-gg-19 — Health-advice guard classifies the reply, not the inbound (S-49 · `jobs/processAIReply.ts:2513`)
- **Mechanism:** For the same suitability question, a sample that volunteers "consult a doctor" is replaced+paused+alerted; a sample that answers without the phrase is sent. The classifier is fail-open, the opposite polarity of the gap guard on the same infrastructure event.
- **Manifests when:** usage intent true; advice wording varies across samples.
- **Impact:** Escalation lottery on reply wording; guard suite polarity inconsistent under outage (correct/wrong/escalate).
- **Determinism achievable:** Partially — classifying the *inbound* (stable input) instead of the sampled reply removes reply-wording dependence; classification stays stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-02 (guard classifies the reply, not the inbound), RC-03 (reply-wording variance)

#### DP-gg-20 — Order-confirmation reply classifier cascade (S-50 · `jobs/processAIReply.ts:2576`)
- **Mechanism:** `classifyOrderConfirmationReplyIntent(inbound, reply)` triggers ETA-strip + canonical delivery line + follow-up append AND cascades into four later branches (strip exemption, quality false-flag suppression, uncertain-guard exemption, data-confirmation gate).
- **Manifests when:** Non-escalated turn with reply wording near the order-confirmation boundary.
- **Impact:** Sent text and whether a later deflection escalates both flip on one verdict (correct/wrong/escalate).
- **Determinism achievable:** Partially — deriving order-flow state from persisted conversation/order state instead of reply wording is a deterministic alternative for most of the cascade.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (order-confirmation reply-classifier cascade)

#### DP-gg-21 — Data-confirmation gate three-way override (S-52 · `jobs/processAIReply.ts:2642`)
- **Mechanism:** Mixes deterministic name/phone regex extraction over the window with two LLM verdicts to pick between: reply as-is, `DATA_CONFIRMATION_MESSAGES` override, or `MISSING_CUSTOMER_NAME_MESSAGES` override; both overrides also reset `isOrderConfirmationReply=false`, changing downstream behavior.
- **Manifests when:** Order-confirmation-like state; extractor/verdict boundaries.
- **Impact:** Which fixed message the customer receives flips on a wording blip (correct/wrong).
- **Determinism achievable:** Partially — an explicit order-collection state machine (persisted) would decide overrides deterministically; verdicts stochastic today.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (data-confirmation classifier override)

#### DP-gg-22 — Repeated-order-closing strip with unused state parameter (S-53 · `jobs/processAIReply.ts:2674`)
- **Mechanism:** `stripRepeatedOrderClosingQuestion`'s second parameter is unused — the hybrid regex+LLM detector strips an order-closing question whenever it finds one, regardless of whether one was ever asked; a regex tail-fallback can amputate single-line replies.
- **Manifests when:** Reply contains (or is judged to contain) order-closing phrasing.
- **Impact:** A legitimate *first* "do you want to order?" is silently deleted, changing the sales flow (correct/wrong).
- **Determinism achievable:** Partially — honoring the conversation-state parameter makes stripping conditional on deterministic state; the detector remains stochastic.
- **Management:** eliminate (wire the state check; strip only on repeat).
- **Confirmed root cause:** RC-03 (strip operates on the sampled reply)

#### DP-gg-23 — Follow-up-invitation strip drops the final sentence (S-54 · `jobs/processAIReply.ts:2682`)
- **Mechanism:** An LLM whole-reply gate; when it flags but per-sentence regexes cannot isolate the invitation, a last-resort heuristic drops the reply's final sentence — which may be a price or instruction.
- **Manifests when:** Non-order-confirmation reply; gate flags; regex fails to isolate.
- **Impact:** Substantive content silently deleted on a false-positive verdict (correct/wrong).
- **Determinism achievable:** Partially — "never delete without deterministic isolation" removes the destructive branch; the gate stays stochastic.
- **Management:** bound (require regex isolation before any strip).
- **Confirmed root cause:** RC-03 (strip operates on the sampled reply)

#### DP-gg-24 — Quality-eval score jitter + threshold drift (S-55 · `jobs/processAIReply.ts:2708`)
- **Mechanism:** Eval model scores the stochastic reply; near-threshold jitter flips flagged+paused vs clean; any eval error returns null (never flags); code default threshold 0.1 vs `.env.example` 0.6 — a 6x floor difference between environments.
- **Manifests when:** Non-exempt reply near threshold, eval transport error, or env drift.
- **Impact:** Same reply paused in one environment, clean in another (correct/wrong/escalate).
- **Determinism achievable:** Partially — threshold unification and error policy are deterministic; the score itself is stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-15 (quality-eval jitter + threshold drift 0.1 vs 0.6)

#### DP-gg-25 — False-flag suppression via stacked classifiers (S-55 · `jobs/processAIReply.ts:2740`)
- **Mechanism:** A quality flag is cleared when flagReason is suppressible AND either of two further LLM verdicts returns true — the flag's fate is itself stochastic.
- **Manifests when:** Eval flagged with a suppressible reason; order-flow classifiers borderline.
- **Impact:** Quality-alert+pause vs no alert from stacked verdicts (correct/escalate).
- **Determinism achievable:** Partially — suppression could key off persisted order-flow state instead of fresh classifier calls.
- **Management:** bound.
- **Confirmed root cause:** RC-15 (quality-flag suppression), RC-08 (stacked classifier verdicts)

#### DP-gg-26 — Price guard on sampled text (S-56 · `jobs/processAIReply.ts:2792`)
- **Mechanism:** The guard is a pure deterministic regex, but its input is the sampled reply: one sample rounds 9.99 to "10 euro" → full replacement + pause + `hallucinated_price` alert; another quotes 9.99 → sent. Fail-open when the catalog carries no prices; does not reset `human_replied` (unlike sibling guards) so use-case eligibility differs by which guard fired.
- **Manifests when:** Matched products with prices; reply states any non-catalog numeric price.
- **Impact:** Answer vs escalation on wording; billing-state asymmetry across guards (correct/escalate).
- **Determinism achievable:** Partially — the guard is already deterministic; residual variance is DP-gg-01's wording. The `human_replied` asymmetry is deterministic and removable.
- **Management:** bound (plus eliminate the guard-family asymmetry).
- **Confirmed root cause:** RC-02 (price guard vs per-turn window)

#### DP-gg-28 — Product-name hallucination validator (S-57 · `jobs/processAIReply.ts:2857`)
- **Mechanism:** LLM validator (temp 0, reply truncated to 1,200 chars) judges names in the sampled reply against matched catalog names; it can flag a legitimate shorthand in one run and pass it the next; fail-open twice; names after char 1,200 never checked.
- **Manifests when:** Non-escalated turn with matched products; verdict or transport variance.
- **Impact:** Answer vs holding+pause for the same correct data; invented names sail through during a blip (correct/wrong/escalate).
- **Determinism achievable:** Partially — deterministic fuzzy-matching against catalog names could replace much of the LLM's job; the LLM residue stays stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-02 (name guard vs per-turn window)

#### DP-gg-29 — Uncertain-answer guard: deterministic predicate, stochastic inputs (S-58 · `jobs/processAIReply.ts:2900`)
- **Mechanism:** Pure predicate over three stochastic inputs (reply wording, `classifyNegativeAvailabilityReply` verdict, `matchedProducts.length`); negative availability with matched products passes, the same wording with zero matched products is replaced by GET_BACK_TO_YOU + pause + `human_replied` reset. Master env switch `UNCERTAIN_ANSWER_FALLBACK_ENABLED` is undocumented.
- **Manifests when:** Deflection-flavored wording or negative-availability verdict with an empty matched set.
- **Impact:** Escalation depends on the conjunction of two upstream coin-flips (correct/escalate).
- **Determinism achievable:** Partially — predicate is deterministic; inputs inherit DP-gg-01 and retrieval variance; the env switch is eliminable drift.
- **Management:** bound.
- **Confirmed root cause:** RC-02 (guard predicate over matchedProducts)

#### DP-gg-30 — Product-image request override (S-61 · `jobs/processAIReply.ts:2967`)
- **Mechanism:** `classifyProductImageRequest` is launched with `.catch(() => null)` (a transport error silently disables the whole feature); when it fires, the fully-guarded reply is wholesale replaced by canned photo text, with target resolution picking between image sends, a missing-image append, a "photo shortly" holding, or fallback to the original reply on a resolution throw.
- **Manifests when:** Photo-request-flavored message; classifier verdict, product_refs extraction, or catalog augmentation varies.
- **Impact:** Four different customer experiences for the same request (correct/wrong/escalate).
- **Determinism achievable:** Partially — resolution and failure policy can be deterministic; the trigger classifier cannot.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (product-image request classifier trigger)

#### DP-po-11 — Retry regenerates different text than was delivered (S-65 · `jobs/processAIReply.ts:3195`)
- **Mechanism:** On an alreadySent retry the whole job re-runs including `generateReply` and all guards before the send is skipped; the persisted row's content is the *fresh* sample, which can differ from the text the customer actually received.
- **Manifests when:** Retry after successful send but before persist; any sampling variance between attempts.
- **Impact:** DB record diverges from the delivered message; guard alerts reference text never sent (correct/wrong/escalate).
- **Determinism achievable:** Yes — persisting the reply (or staging it durably) before/with the send makes the record deterministic irrespective of sampling.
- **Management:** eliminate (persist-before-send / durable staging keyed to the inbound message).
- **Confirmed root cause:** RC-20 (retry regenerates text ≠ delivered)

#### DP-po-17 — Purchase-intent score at the 0.85 knife-edge (S-69 · `services/intentDetectionService.ts:147`)
- **Mechanism:** Temp-0 intent detection with no seed; `intent_score` near the threshold flips between runs; `is_ready_to_order` is likewise model-asserted.
- **Manifests when:** Score sampled near `intentOrderMinScore`; any provider nondeterminism.
- **Impact:** Order created vs silent skip for identical conversations (correct/wrong/silence).
- **Determinism achievable:** Partially — persisting the verdict per turn removes retry re-rolls; boundary variance remains.
- **Management:** bound.
- **Confirmed root cause:** RC-08 (0.85 knife-edge), RC-22 (intent-gated order creation)

#### DP-po-21 — `shouldAffirmOrder` disjunction of verdicts (S-70 · `jobs/processAIReply.ts:3586`)
- **Mechanism:** Disjunction of `classifyNewOrderSignal` (keyword fallback on error) and `detectOrderAffirmationIntent` (>0.7 knife-edge, no boost) plus heuristic scans; `explicitNewOrder=true` additionally bypasses the data-confirmation requirement and the duplicate guard.
- **Manifests when:** Confidence near 0.7; LLM error dropping to keyword fallback; data-confirmation message outside the window.
- **Impact:** Any single flip toggles order creation and which guards apply (correct/wrong/silence).
- **Determinism achievable:** Partially.
- **Management:** bound.
- **Confirmed root cause:** RC-07 (affirmation lacks boost), RC-22 (order affirmation)

#### DP-po-30 — 7-way draft-order conjunction (S-70 · `jobs/processAIReply.ts:3605`)
- **Mechanism:** Five of seven conjuncts derive from LLM output on this run; flip probabilities multiply, so near the knife-edge identical conversations mostly skip and occasionally order — every skip is a silent return [E28].
- **Manifests when:** Any conjunct near its boundary, typically on confirmation-style turns.
- **Impact:** The customer sees a confirmation-style reply either way, but only some executions produce an order row — direct revenue impact (correct/wrong/silence).
- **Determinism achievable:** Partially — persisting per-turn verdicts and an explicit order state machine collapse most variance; extraction stochasticity remains.
- **Management:** bound (plus the existing full-flag-payload skip log as detection).
- **Confirmed root cause:** RC-22 (7-conjunct draft-order gate), RC-07 (affirmation conjunct)

#### DP-po-23 — Product resolution seeded by LLM free-text (S-71 · `services/orderProductResolutionService.ts:138`)
- **Mechanism:** Candidate set is seeded from the intent LLM's free-text `product_name`; small string variations change the candidate family, flipping between unique (order), ambiguous (clarification question), no_candidates, and out-of-stock silent skips.
- **Manifests when:** Variant families in the catalog; product_name phrasing varies across runs.
- **Impact:** Order vs clarification vs silence for the same purchase (correct/wrong/escalate/silence).
- **Determinism achievable:** Partially — resolving against persisted matched-product ids (rather than free text) is deterministic where available; extraction remains stochastic.
- **Management:** bound.
- **Confirmed root cause:** RC-22 (draft-order product resolution), RC-13 (persisted-id resolution)

#### DP-po-24 — Locale-dependent clarification dedupe (S-71 · `jobs/processAIReply.ts:3679`)
- **Mechanism:** Duplicate suppression scans the last 8 messages for the locale-specific lead-in string; locale re-detection flips (sq/en) make the scan search for the wrong-language lead-in and re-send the clarification.
- **Manifests when:** Repeated ambiguous resolutions with locale-detection variance or >8 intervening messages.
- **Impact:** Duplicate clarification questions in the thread (correct/wrong).
- **Determinism achievable:** Yes — a locale-independent structural marker (message metadata flag) makes the dedupe deterministic.
- **Management:** eliminate.
- **Confirmed root cause:** RC-10 (locale-dependent clarification dedupe)

### Class 2 — Concurrency (17 rows)

Races between workers, jobs, locks, and counters. This is the class with the highest fraction of fully achievable determinism: most rows are idempotency/serialization defects with standard mechanical fixes.

#### DP-iq-14 — Check-then-insert dedupe TOCTOU (S-07 · `jobs/processInboundMessage.ts:465`)
- **Mechanism:** With webhook concurrency 10, two jobs carrying the same message (distinct payload variants that passed edge dedupe separately) can both pass the SELECT before either INSERTs; the loser throws on UNIQUE(external_message_id), but both already re-ran Graph fetches and uploads, and the winner determines which payload variant persisted.
- **Manifests when:** Duplicate deliveries with differing dedupe keys processed concurrently.
- **Impact:** Which content variant is stored is race-determined; wasted external calls (correct/wrong).
- **Determinism achievable:** Yes — INSERT … ON CONFLICT as the atomic anchor before side effects.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (INSERT … ON CONFLICT idempotency anchor)

#### DP-iq-18 — Parallel webhook workers invert message order (S-12 · `jobs/workers.ts:77`)
- **Mechanism:** Concurrency (default 10, prod 3) processes jobs for the same conversation in parallel; two rapid messages A then B can persist B-then-A (`created_at` reflects processing, not send time), inverting "latest inbound" identity and burst-merge order.
- **Manifests when:** Two inbound webhooks for one conversation complete out of order.
- **Impact:** Merged text answered in the wrong order, or the stale-job guard drops the customer's actual last message (correct/wrong/silence).
- **Determinism achievable:** Yes — ordering by the platform-supplied timestamp (present in rawPayload) and/or per-conversation FIFO restores deterministic order.
- **Management:** eliminate.
- **Confirmed root cause:** RC-05 (message-order inversion feeds burst composition)

#### DP-iq-17 — Debounce removes at most one pending job (S-13 · `jobs/processInboundMessage.ts:889`)
- **Mechanism:** The debounce uses `.find()` — one removal — while fairness/lock/hold self-reschedules add extra pending jobs with the same name; survivors consume rate-limit budget before hitting the stale guard.
- **Manifests when:** A self-rescheduled job pending simultaneously with a new inbound's debounce.
- **Impact:** Phantom jobs burn the 25/h budget unevenly, changing when [E3] permanent pause triggers (correct/silence).
- **Determinism achievable:** Yes — deterministic jobId scheme (one pending job per conversation) removes the phantom population.
- **Management:** eliminate.
- **Confirmed root cause:** RC-05 (debounce single-removal), RC-18 (phantom budget burn)

#### DP-iq-19 — Tenant fairness slot: unbounded re-adds + counter drift (S-14 · `jobs/processAIReply.ts:1164`, merged DP-GPR-01/02)
- **Mechanism:** Over the per-tenant cap the job re-adds itself as a brand-new job (fresh attempts, no jobId) and reports success; the counter's 300s EXPIRE is set only on first INCR, so expiry mid-flight lets finally-DECRs drive it negative, silently raising effective concurrency.
- **Manifests when:** Tenant at/near `AI_MAX_CONCURRENT_PER_TENANT`, or any job running >300s.
- **Impact:** Latency divergence and staleness-guard losses under load (correct/silence).
- **Determinism achievable:** Partially — counter-drift and retry-budget bugs are mechanically fixable; queueing latency under load is inherently load-dependent.
- **Management:** bound.
- **Confirmed root cause:** RC-20 (retry re-add + counter drift; cited in RC-20 evidence)

#### DP-iq-20 — Conversation lock: contention loop + error-as-busy (S-15 · `jobs/processAIReply.ts:1204`, merged DP-GPR-03)
- **Mechanism:** Lock contention re-adds a fresh job every 3s; a crashed holder keeps the conversation locked up to the 300s TTL, and the SET's `.catch(() => false)` makes a Redis error indistinguishable from contention.
- **Manifests when:** Concurrent jobs for one conversation, crashed holder, or Redis errors during SET NX.
- **Impact:** Delay that the stale-job guard converts into silence for the original message (correct/silence).
- **Determinism achievable:** Partially — error-vs-contention discrimination and lock heartbeats are fixable; contention delay itself is inherent to serialization.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-GPR-04 — Lock TTL shorter than worst-case job wall-time (S-15 · `jobs/processAIReply.ts:1200`)
- **Mechanism:** 300s TTL vs a pass that can make 18–25+ serialized LLM calls (each 60s×3 retries); the lock expires mid-job, a second job acquires it, and two pipelines run concurrently over the same history.
- **Manifests when:** Job wall-time > 300s plus a queued job for the same conversation.
- **Impact:** Duplicate or contradictory replies for one inbound (correct/wrong).
- **Determinism achievable:** Yes — lock renewal (heartbeat) for the duration of the job eliminates mid-job expiry.
- **Management:** eliminate.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-iq-21 — Rate counter INCRs per attempt, pre-gate (S-16 · `jobs/processAIReply.ts:1231`, merged DP-GPR-05)
- **Mechanism:** The 25/h counter increments once per job *attempt*, before enablement gates and the staleness guard — retries, stale-skipped jobs, and disabled-AI jobs all consume budget without producing replies.
- **Manifests when:** Conversation near the hourly cap; retries/stale jobs inflate the count.
- **Impact:** At the boundary: normal reply vs [E3] persistent `ai_paused` + `rate_limit_exceeded` alert + customer silence (correct/escalate/silence).
- **Determinism achievable:** Yes — counting only delivered replies (idempotent per message id, post-send) makes the budget a deterministic function of actual output.
- **Management:** eliminate.
- **Confirmed root cause:** RC-18 (rate counter INCRs per attempt before gates)

#### DP-iq-25 — Human-hold reschedule loops (S-19 · `jobs/processAIReply.ts:470`)
- **Mechanism:** Each hold reschedule adds a fresh job (no jobId) at remaining+5s; every subsequent human reply re-extends the hold, so rescheduled jobs loop and accumulate, invisible to dedup and only partially visible to the debounce.
- **Manifests when:** Repeated human replies extending `human_override_until` while a customer message awaits.
- **Impact:** The eventual survivor answers whatever is latest — or nothing (correct/wrong/silence).
- **Determinism achievable:** Partially — deterministic jobId dedup collapses the population; human-activity timing is external.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-GPR-29 — Contact-scoped order selection race (S-23 · `jobs/processAIReply.ts:1392`)
- **Mechanism:** `findLatestOpenOrderForContactForEscalation` is contact-scoped, so which order gets flagged cancellation/refund-requested depends on order rows racing this job; with no candidate the ack/alert/pause still fire but nothing is flagged.
- **Manifests when:** Contact has multiple or changing open orders at detection time.
- **Impact:** Wrong order flagged, or alert-only with no order flagged (correct/wrong/escalate).
- **Determinism achievable:** Partially — conversation-scoping and row locking make selection deterministic given state; concurrent order creation remains a race.
- **Management:** bound.
- **Confirmed root cause:** RC-19 (within the umbrella escalation block), RC-22 (order selection race)

#### DP-pc-02 — Cache refill resurrects pre-edit values (S-31 · `services/aiService.ts:203`)
- **Mechanism:** Read-aside loaders with no versioning: a loader that finished its DB read can SET immediately after the invalidation DEL, resurrecting the stale value for a further full TTL.
- **Manifests when:** Invalidation DEL lands between a concurrent loader's DB read and its Redis SET.
- **Impact:** Some workers read resurrected stale config, others fresh (correct/wrong).
- **Determinism achievable:** Yes — versioned cache keys or check-and-set eliminate the resurrection window.
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (cache-refill resurrection window)

#### DP-po-03 — Send precheck bypassed on escalation path (S-62 · `jobs/processAIReply.ts:3076`)
- **Mechanism:** `shouldStillSendAutomatedReply` is skipped entirely when `knowledgeGapEscalated || alreadySent`, so the holding message is sent even if AI was paused, a human took over, or a newer inbound superseded the job.
- **Manifests when:** Knowledge-gap escalation coinciding with takeover/pause/newer inbound; or any retry.
- **Impact:** Holding message lands on top of a human reply (correct/wrong).
- **Determinism achievable:** Yes — always run the precheck; the bypass is a code decision.
- **Management:** eliminate.
- **Confirmed root cause:** RC-06 (send-time state re-read / precheck bypass)

#### DP-po-04 — Send precheck races the generation window (S-62 · `jobs/processAIReply.ts:3084`)
- **Mechanism:** The precheck re-reads config/channel/conversation/messages at send time; whether a human reply / newer inbound / pause lands during the multi-second generation window decides send vs silent return [E26].
- **Manifests when:** Human or customer activity during job execution (window often tens of seconds).
- **Impact:** Reply vs silence purely on race timing (correct/silence).
- **Determinism achievable:** Partially — the window can be narrowed and the decision made atomic against a conversation sequence number, but human activity timing is external reality.
- **Management:** bound.
- **Confirmed root cause:** RC-06 (send-time state re-read race)

#### DP-po-06 — Outbound channel token bucket (S-63 · `services/outboundChannelRateLimiter.ts:94`)
- **Mechanism:** Per-channel bucket (default 200/h) polls up to 60s then throws; sendMessage converts it to `{success:false}` — a terminal failure (no retry).
- **Manifests when:** Channel volume near `OUTBOUND_API_MAX_PER_HOUR` with concurrent jobs draining the bucket.
- **Impact:** Delivered vs terminally-failed for identical messages under load (correct/silence/escalate).
- **Determinism achievable:** Partially — load-dependence is inherent; converting terminal failure into deterministic queued-retry bounds the divergence to latency.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-po-09 — Retry after persist dead-letters on unique violation (S-65 · `jobs/processAIReply.ts:3199`)
- **Mechanism:** Crash after the outbound row persisted → retry skips the send, re-runs `createMessage` reusing `priorGraphMessageId`; globally-unique `external_message_id` with no ON CONFLICT throws every attempt; after 3, the job dead-letters and S-66…S-73 (alerts, analytics, use-case enqueue, draft order) never execute.
- **Manifests when:** Crash between persist and job ack on FB/IG/Viber.
- **Impact:** Customer got the reply but billing/order bookkeeping is permanently unexecuted (correct/silence).
- **Determinism achievable:** Yes — idempotent persist (ON CONFLICT DO NOTHING + resume) converges retries to the completed state.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (retry dead-letters on global UNIQUE external_message_id)

#### DP-po-25 — Clarification send: no idempotency, no precheck (S-71 · `jobs/processAIReply.ts:3693`)
- **Mechanism:** The variant-clarification send has no Redis marker and no `shouldStillSendAutomatedReply`; a crash between send and persist leaves no DB row for the last-8 scan, so the retry re-sends; it can also fire after human takeover.
- **Manifests when:** Crash between clarify send and persist + retry; or takeover during the draft-order tail.
- **Impact:** Duplicate clarification questions; bot talks over the human (correct/wrong).
- **Determinism achievable:** Yes — same idempotency-marker + precheck pattern as the main send.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (clarify-send idempotency), RC-22 (draft-order tail)

#### DP-po-26 — Duplicate-order suppression is application-level only (S-72 · `jobs/processAIReply.ts:3755`)
- **Mechanism:** Read-then-insert with no DB uniqueness; serialization relies on the 300s conversation lock, which a long pipeline can outlive — both jobs read "no active order" and both insert.
- **Manifests when:** Two ai.reply jobs overlapping after lock TTL expiry.
- **Impact:** Two draft orders for one purchase — direct billing impact (correct/wrong).
- **Determinism achievable:** Yes — a DB uniqueness/idempotency key (e.g., per conversation + inbound message) makes creation exactly-once.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (order idempotency), RC-22 (duplicate draft order)

#### DP-retrieval-13 — Catalog mutation between turns shrinks persisted context (S-36 · `db/models/product.ts:285`)
- **Mechanism:** Persisted `product_ids` rehydration filters `deleted_at IS NULL AND is_active = true` and silently drops missing rows — a merchant deactivating a product between turns shrinks the context, possibly to zero, rerouting resolution down the fragile anchor chain.
- **Manifests when:** Referenced product deactivated/deleted/edited between recommendation and follow-up.
- **Impact:** The same follow-up minutes apart resolves against different product sets with no notice (correct/wrong/escalate).
- **Determinism achievable:** No — the state legitimately changed; the divergence reflects real catalog mutation, not a defect in execution. Behavior can be made *explicit* but not replay-identical.
- **Management:** detect+log (surface "context shrank due to catalog change" instead of silent filtering).
- **Confirmed root cause:** RC-13 (persisted-context shrink on catalog mutation)

### Class 3 — Timing (21 rows)

Windows between receipt and action, debounce boundaries, TTLs, and check-then-act gaps. Mostly boundable; a fixed debounce boundary (DP-iq-16) is the one structurally unavoidable member.

#### DP-iq-02 — Late delivery rejected forever (S-03 · `controllers/webhookController.ts:304`)
- **Mechanism:** A delivery arriving >300s after its body timestamp is 403'd and never enqueued; platform redeliveries carry the same stale timestamp and are rejected forever.
- **Manifests when:** Delivery latency or platform-side retry pushes |now − ts| beyond `WEBHOOK_TS_MAX_SKEW_MS`.
- **Impact:** Prompt delivery → reply; late delivery → permanent silence (correct/silence).
- **Determinism achievable:** Partially — platform latency is external; the *policy* (accept-and-flag vs reject) can be made deterministic and non-destructive.
- **Management:** bound.
- **Confirmed root cause:** RC-11 (300s skew 403s late-but-valid deliveries)

#### DP-iq-08 — Channel-resolution retry window (S-08 · `jobs/processInboundMessage.ts:485`)
- **Mechanism:** Channel-not-found throws with 3 attempts at fixed 5s: a webhook racing channel creation succeeds if the row commits within ~10s, otherwise the message is permanently lost (ops alert only in prod).
- **Manifests when:** Webhook arrives mid-onboarding/reconnect or on external_id mismatch.
- **Impact:** Identical message, divergent outcome by a ~10-second provisioning window (correct/silence).
- **Determinism achievable:** Partially — longer backoff and a replayable DLQ bound the loss; the provisioning race is external.
- **Management:** bound.
- **Confirmed root cause:** RC-09 (channel-resolution path; RC-09 cites processInboundMessage.ts:485)

#### DP-iq-13 — 5-minute echo content-dedupe window (S-11 · `jobs/processInboundMessage.ts:764`)
- **Mechanism:** API-origin echoes whose mid differs from the recorded send id are deduped by content within `ECHO_DEDUP_WINDOW_MS` = 5 min; a later or content-mutated echo is stored as a second outbound 'ai' row, entering the 40-message window and changing every subsequent prompt.
- **Manifests when:** Echo delayed >5 min or content mismatch, with the self-echo registry also missed.
- **Impact:** Duplicate assistant turn poisons future context (correct/wrong).
- **Determinism achievable:** Partially — durable send-id registration widens correct matching; platform echo latency is external.
- **Management:** bound.
- **Confirmed root cause:** RC-24 (5-min echo content-dedupe window)

#### DP-iq-16 — 8s debounce boundary (S-13 · `jobs/processInboundMessage.ts:905`)
- **Mechanism:** Two rapid messages produce one merged reply if the second arrives while the first job is still delayed/waiting, but two replies (or a stale-skip [E11] silence) if it went active — a message at t+7.9s vs t+8.5s yields materially different output. `AI_REPLY_DELAY_MS` is env-overridable and absent from `.env.example`.
- **Manifests when:** Inter-message gap near the delay boundary.
- **Impact:** Different reply count and content for the same two texts (correct/wrong/silence).
- **Determinism achievable:** No — any fixed debounce produces a boundary; the discontinuity can be moved or smoothed but not removed at this stage.
- **Management:** accept (document the boundary; keep it consistent across environments).
- **Confirmed root cause:** RC-05 (8s debounce boundary)

#### DP-iq-23 — Enablement gates evaluated at job-run time (S-17 · `jobs/processAIReply.ts:1296`, merged DP-GPR-07)
- **Mechanism:** All three gates (`is_active`, `ai_enabled`, `ai_paused`/`human_override_until`) are read ≥8s (possibly minutes) after receipt; any toggle inside that window changes the outcome class of an already-received message with no notification [E4/E6/E8/E9].
- **Manifests when:** Tenant/staff toggles AI or a human hold lands within the receipt-to-run window.
- **Impact:** Reply vs silent drop vs deferred, one second apart around a toggle (correct/silence).
- **Determinism achievable:** Partially — snapshot semantics (gate state stamped at receipt) makes outcomes deterministic given toggle timestamps, but toggles racing receipt remain a real-time race.
- **Management:** bound (define and log gate-evaluation semantics; leave an artifact when a received message is discarded).
- **Confirmed root cause:** RC-06 (enablement gates evaluated at job-run time)

#### DP-iq-24 — Human-hold reschedule three-condition window (S-19 · `jobs/processAIReply.ts:438`, merged DP-GPR-08)
- **Mechanism:** The deferral runs only when remaining hold ≤ `HUMAN_HOLD_MINUTES`+60s (holds that merely look long after an env change silently skip), the job is still for the latest inbound, and no human outbound followed — each condition converts the same message into deferred vs permanent silence.
- **Manifests when:** Hold active at job run; hold length vs current env value; human timing.
- **Impact:** Deferred reply vs silence based on human activity timing and config, not content (correct/silence).
- **Determinism achievable:** Partially — the anomaly heuristic and env coupling are removable; human timing is external.
- **Management:** bound.
- **Confirmed root cause:** RC-06 (human-hold reschedule window)

#### DP-GPR-09 — Hold reschedule races message persistence (S-19 · `jobs/processAIReply.ts:449`)
- **Mechanism:** The reschedule silently declines when a newer inbound or human outbound exists — both checks race persistence by milliseconds; the rescheduled fresh job is also removable by the debounce.
- **Manifests when:** Concurrent inbound or human reply during the hold-active branch.
- **Impact:** Rescheduled vs silent-trusting-a-newer-job that may not survive (correct/silence).
- **Determinism achievable:** Partially — guaranteed-successor semantics (deterministic jobId) close most of the gap.
- **Management:** bound.
- **Confirmed root cause:** RC-06 (hold reschedule races message persistence)

#### DP-GPR-10 — Burst composition depends on outbound persist timing (S-20 · `jobs/processAIReply.ts:311`)
- **Mechanism:** Burst = inbounds after the most recent outbound in the window; whether the previous outbound row had persisted when this job loaded history decides whether the latest inbound is classified alone or fused with earlier questions — changing the text every pre-reply detector sees.
- **Manifests when:** Multiple inbounds around an outbound send/persist boundary.
- **Impact:** Different merged text → different detector, retrieval, and generation outcomes (correct/wrong/escalate/silence).
- **Determinism achievable:** Partially — a burst definition anchored to platform timestamps and send records is deterministic given state; the persist race narrows but does not vanish.
- **Management:** bound.
- **Confirmed root cause:** RC-05 (burst composition vs outbound-persist timing)

#### DP-GPR-12 — Stale-job delegation can strand both messages (S-21 · `jobs/processAIReply.ts:1345`)
- **Mechanism:** The stale guard exits silently assuming the newer message's job survives — but debounce removal and re-add loops can leave the surviving job carrying the *older* external id, which then also exits stale.
- **Manifests when:** Rapid successive inbounds racing execution, removal, and re-add loops.
- **Impact:** No reply to either message (correct/silence).
- **Determinism achievable:** Yes — a guaranteed-successor invariant (exactly one pending job keyed to the latest inbound) makes delegation safe.
- **Management:** eliminate.
- **Confirmed root cause:** RC-05 (stale-job delegation strands both messages)

#### DP-GPR-19 — Detected escalation evaporates on precheck failure (S-23 · `jobs/processAIReply.ts:1409`)
- **Mechanism:** When cancel/refund intent IS confidently detected but the send precheck fails, the path returns with no alert, no pause, no order flag — relying on the newer message's job to re-detect over a differently-merged burst. Same pattern at 1514/1661/1725/1863.
- **Manifests when:** Newer inbound or human reply lands between detection and precheck.
- **Impact:** A detected escalation silently lost (correct/silence).
- **Determinism achievable:** Yes — persist detection artifacts (alert/flag) independently of the send decision.
- **Management:** eliminate.
- **Confirmed root cause:** RC-19 (detected escalation lost on precheck failure)

#### DP-GPR-30 — Check-then-act gap on every pre-reply send (S-23 · `jobs/processAIReply.ts:1403`)
- **Mechanism:** `shouldStillSendAutomatedReply` has no lock spanning check→send: a human reply landing in the gap still lets the canned/holding message go out. Applies to all five pre-reply send sites.
- **Manifests when:** Human agent replies within the check-to-send window.
- **Impact:** Double answer — human + bot (correct/wrong).
- **Determinism achievable:** Partially — the external channel send cannot be made atomic with the DB check; the window can only be minimized.
- **Management:** bound.
- **Confirmed root cause:** RC-19 (check-then-act gap on every pre-reply send)

#### DP-GPR-27 — Order mutated before the send precheck (S-29 · `jobs/processAIReply.ts:1851`)
- **Mechanism:** `updateOrderCustomerInfoForAI` executes before the precheck; if the precheck then fails, the order is already mutated with no confirmation, no `order_info_updated` alert, no sockets — and the umbrella catch swallows any later throw the same way.
- **Manifests when:** Precheck-failing event lands after the UPDATE, or any throw after it.
- **Impact:** Silent order mutation invisible to the tenant (wrong/silence).
- **Determinism achievable:** Yes — reorder (precheck → transactional mutate+alert) makes the artifact set deterministic.
- **Management:** eliminate.
- **Confirmed root cause:** RC-19 (order mutated before send precheck)

#### DP-retrieval-01 — 5s embedding race drops the semantic source (S-33 · `services/aiService.ts:655`)
- **Mechanism:** Query embedding races a 5s timer; >5s resolves null and fusion silently runs lexical-only (losing the weight-2.0 source).
- **Manifests when:** OpenAI embeddings latency >5s on a cache-miss query.
- **Impact:** Different product sets retrieved either side of a latency spike (correct/wrong/escalate).
- **Determinism achievable:** Partially — the timeout is an availability/latency tradeoff; caching and retry make repeats deterministic, first-call latency exposure remains.
- **Management:** bound (the `semanticSkipped` warn already provides detection).
- **Confirmed root cause:** RC-04 (5s embedding race drops the semantic source)

#### DP-retrieval-23 — Race loser never cached; degradation self-amplifies (S-33 · `services/aiService.ts:657`)
- **Mechanism:** The 5s race does not abort the losing OpenAI call (it burns rate limit for up to 60s×3) and its eventual vector is never cached — timed-out texts time out again while orphaned calls worsen rate-limit pressure.
- **Manifests when:** Sustained OpenAI slowness plus message volume.
- **Impact:** `semanticSkipped` becomes sticky for hot conversations (correct/wrong).
- **Determinism achievable:** Yes — caching late-arriving vectors (or aborting the call) removes the self-amplification loop.
- **Management:** eliminate.
- **Confirmed root cause:** RC-04 (race loser never cached; self-amplifying)

#### DP-retrieval-14 — Anchor path compounds independent timing coin-flips (S-36 · `services/productRetrievalService.ts:209`)
- **Mechanism:** When persisted ids are empty, anchor extraction + up to 4 keyword re-runs of the full RRF matcher + assistant-text fallback each carry their own independent 5s embedding race and error swallow.
- **Manifests when:** Anchor path reached; OpenAI latency variance; catalog-ambiguous AI prose.
- **Impact:** Resolved product set compounds several coin-flips; AI prose can match tangential products (correct/wrong/escalate).
- **Determinism achievable:** Partially — inherits retrieval-01; reducing nested searches shrinks the compound surface.
- **Management:** bound.
- **Confirmed root cause:** RC-13 (anchor path), RC-04 (compounded embedding races)

#### DP-retrieval-19 — Zero-hit self-heal is fire-and-forget (S-36 · `services/aiService.ts:3740`)
- **Mechanism:** On empty retrieval, NULL-embedding rows are counted and priority re-embed jobs enqueued, but the *current* reply proceeds with `products=[]` (clarify guardrail); the identical message after the heal retrieves real products.
- **Manifests when:** Tenant with un-embedded products (bulk import, backlog) gets a product query whose lexical paths also miss.
- **Impact:** First-contact-after-import systematically diverges from the retry moments later (correct/wrong/escalate).
- **Determinism achievable:** Partially — the coverage gap window can be shrunk (synchronous embed on import) but not eliminated for arbitrary backlog.
- **Management:** bound (the coverage-gap warn is the detection signal).
- **Confirmed root cause:** RC-04 (zero-hit self-heal / embedding-coverage gap)

#### DP-pc-15 — Burst merge duplicates content as an extra user turn (S-40 · `services/aiService.ts:3147`)
- **Mechanism:** The inbound-dedup compares the last history user turn against the trimmed inbound; a burst-merged `inboundMessage` never equals the single last row, so the merged text is appended as an extra user turn duplicating history rows — and whether the burst merged at all depends on the 8s debounce.
- **Manifests when:** Multiple inbounds since the last outbound merged into one query text.
- **Impact:** Different message arrays for messages sent 1s vs 10s apart (correct/wrong).
- **Determinism achievable:** Yes — building the prompt purely from history rows (no re-appended merged text) is deterministic given the window.
- **Management:** eliminate.
- **Confirmed root cause:** RC-05 (burst-merge duplicates an extra user turn)

#### DP-po-02 — 1-hour send-marker TTL (S-62 · `jobs/processAIReply.ts:3104`)
- **Mechanism:** A retry or re-enqueued job for the same inbound executing >1h after the original send finds the idempotency marker expired and delivers a second copy.
- **Manifests when:** Worker stall, queue backlog, or manual re-run beyond 3600s.
- **Impact:** Duplicate delivery (correct/wrong).
- **Determinism achievable:** Yes — DB-anchored idempotency (the persisted outbound row) has no TTL.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (1h send-marker TTL → duplicate delivery)

#### DP-po-14 — Crash between independently-committed transactions (S-66 · `jobs/processAIReply.ts:3446`)
- **Mechanism:** A committed alert+pause pair blocks the retry at the top-of-job gate, so `touchConversationLastMessageAt`, analytics, socket emits, use-case enqueue, and the draft-order block never execute — permanent partial state a crash-free run would not produce.
- **Manifests when:** Process crash after an alert+pause commit but before job completion.
- **Impact:** Stale conversation metadata, missing billing artifacts for the turn (correct/silence).
- **Determinism achievable:** Partially — checkpointed resumption converges most of the partial state; crash timing is environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-20 (crash between independently-committed transactions)

#### DP-po-27 — createOrder retry duplication via classifier flip (S-72 · `jobs/processAIReply.ts:3761`)
- **Mechanism:** No idempotency marker on createOrder; the retry's duplicate guard is bypassed when the re-rolled classifier returns `explicitNewOrder=true` or product resolution flips `productChanged`.
- **Manifests when:** Crash between createOrder and job ack + retry with a classifier/resolution flip.
- **Impact:** Second identical order inserted (correct/wrong).
- **Determinism achievable:** Yes — an idempotency key per (conversation, inbound message) makes order creation exactly-once regardless of classifier re-rolls.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (createOrder retry duplication), RC-22 (draft order)

#### DP-po-28 — Commission window computed NOW()-relative (S-73 · `jobs/processAIReply.ts:3788`)
- **Mechanism:** `hasHumanParticipationInCurrentOrderWindow` computes the session boundary relative to evaluation time, after the send: a human reply seconds before the query flips `is_commissionable`; a retry hours later shifts the session-start row across the 3h gap or 30-day horizon.
- **Manifests when:** Human outbound near the evaluation instant; retries/delays crossing boundaries.
- **Impact:** The 5% commission flips on an otherwise identical order — direct revenue nondeterminism (correct/wrong).
- **Determinism achievable:** Yes — anchoring the window to order/message timestamps (not evaluation time) makes the decision a pure function of persisted state.
- **Management:** eliminate.
- **Confirmed root cause:** RC-22 (NOW()-relative commission window)

### Class 4 — Cache staleness (10 rows)

Which cache phase a worker happens to hold decides the prompt, the model, or the classification. Half the class is fully eliminable with versioned invalidation.

#### DP-iq-11 — Self-echo registry miss → AI reply classified as human (S-11 · `services/outboundEchoRegistry.ts:53`)
- **Mechanism:** Echo recognition depends on a Redis key (TTL 600s) whose read errors return false; on Instagram echoes carry no app_id, so a registry miss drops through to `isHumanAgentEcho => true` — sticky `human_replied` (kills use-case billing), 10-min hold, phantom `sent_by:'human'` row.
- **Manifests when:** FB/IG echo whose mid is not in Redis (hiccup/TTL/delay >10min) and whose content misses the 5-min dedupe.
- **Impact:** "AI keeps replying" vs "AI silenced + billing disqualified" purely on Redis availability (correct/silence/wrong).
- **Determinism achievable:** Partially — a durable (DB) send-id record removes the Redis dependence; Instagram's missing app_id is a platform information limit.
- **Management:** bound.
- **Confirmed root cause:** RC-24 (self-echo registry miss → classified human)

#### DP-pc-01 — ai_config cache: 900s TTL, delete-only invalidation (S-31 · `services/aiService.ts:228`)
- **Mechanism:** After an admin edit, worker A (pre-edit cache) and worker B (post-invalidation) assemble different system prompts and can even call different models (`custom_model_id` rides in this cache); the tenant-facing AI toggle never invalidates at all.
- **Manifests when:** ai_configs mutation within the last 900s; jobs land on different cache states.
- **Impact:** Different persona/restrictions/model for identical messages (correct/wrong).
- **Determinism achievable:** Yes — versioned invalidation covering all mutation paths makes reads deterministic w.r.t. the last committed config.
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (ai_config cache 900s, delete-only invalidation)

#### DP-pc-03 — Tenant profile cache, 1800s (S-31 · `services/aiService.ts:282`)
- **Mechanism:** Business profile/delivery_methods cached at double the config TTL; a mid-window edit yields workers whose prompts carry different delivery methods.
- **Manifests when:** Tenant row edited within 1800s via a non-invalidating path, or the DP-pc-02 refill race.
- **Impact:** Divergent delivery answers for identical questions (correct/wrong).
- **Determinism achievable:** Yes — same versioned-invalidation mechanism.
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (tenant-profile cache drift)

#### DP-pc-04 — Prompt-block cache, 900s (S-31 · `services/aiService.ts:265`)
- **Mechanism:** An admin prompt-block patch mid-window produces workers assembling different Guidelines sections (~4.5K tokens of behavioral rules) — e.g., one prompt still containing a retired escalation rule.
- **Manifests when:** tenant_prompt_blocks mutation reaching only some workers' reads.
- **Impact:** Different behavioral rules for the identical inbound (correct/wrong/escalate).
- **Determinism achievable:** Yes.
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (prompt-block cache drift), RC-26 (guideline content)

#### DP-retrieval-03 — Per-process query-embedding cache (S-33 · `services/aiService.ts:616`)
- **Mechanism:** In-process Map (max 256, FIFO): a warm process answers from cache (semantic always present), a cold process must call OpenAI and is exposed to the 5s race — which process handles the job is scheduler-dependent.
- **Manifests when:** Multi-process deployment or restart; repeated query text; latency near the 5s boundary.
- **Impact:** Identical requests diverge by worker affinity (correct/wrong).
- **Determinism achievable:** Partially — a shared (Redis) embedding cache removes affinity dependence; first-computation exposure remains.
- **Management:** bound.
- **Confirmed root cause:** RC-04 (per-process query-embedding cache affinity)

#### DP-retrieval-17 — Embedding nulled on product edit (S-34 · `db/models/product.ts:360`)
- **Mechanism:** Editing any embedding-input field nulls the vector; the row is invisible to semantic search until the re-embed lane repopulates it (seconds to minutes, longer under backlog).
- **Manifests when:** Product edited shortly before the inbound; lexical sources weak for the phrasing.
- **Impact:** The product can vanish from retrieval entirely in the window (correct/wrong/escalate).
- **Determinism achievable:** Partially — the window is boundable (priority lane, synchronous embed on edit) but a nonzero staleness window is inherent to async re-embedding.
- **Management:** bound.
- **Confirmed root cause:** RC-04 (embedding nulled on product edit)

#### DP-retrieval-18 — 6h hash-drift reconcile with scan caps (S-34 · `jobs/reconcileProductEmbeddings.ts:117`)
- **Mechanism:** Stale vectors outside the capped scan window keep serving their old semantic identity; RRF fuses a fresh keyword hit with a stale semantic neighbor.
- **Manifests when:** Drifted rows beyond `RECONCILE_BATCH_LIMIT` caps; up to 6h (or multiple cycles) of lag.
- **Impact:** Wrong product surfaced until the reconcile pass (correct/wrong).
- **Determinism achievable:** Partially — lag boundable, not eliminable, for large catalogs.
- **Management:** bound.
- **Confirmed root cause:** RC-04 (6h hash-drift reconcile lag)

#### DP-retrieval-20 — 120s alphabetical-fallback catalog cache (S-36 · `services/aiService.ts:292`, merged DP-pc-05)
- **Mechanism:** The greeting-path fallback catalog is served from `products:{tenantId}` with 120s TTL; two identical greetings 60s apart can be answered from different 20-product samples.
- **Manifests when:** Non-meaningful query path with a catalog mutation inside the TTL.
- **Impact:** Different product samples presented (correct/wrong).
- **Determinism achievable:** Yes — event-based invalidation on catalog mutation.
- **Management:** eliminate.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-gg-02 — Model selection rides the config cache (S-42 · `services/aiService.ts:4106`)
- **Mechanism:** `config.custom_model_id || OPENAI_CHAT_MODEL || 'gpt-4o'` where config comes from the 900s cache; a cache read failure falls back to defaults, silently running the platform model instead of the fine-tune. The model used is not persisted anywhere.
- **Manifests when:** custom_model_id recently changed, or Redis miss/error during the request.
- **Impact:** Systematically different reply distribution for identical input, unobservable after the fact (correct/wrong).
- **Determinism achievable:** Yes — versioned invalidation plus persisting the model id on the message row makes selection deterministic and auditable.
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (model selection rides the config cache)

#### DP-po-20 — `hasCustomerPhone` source chain varies by history (S-69 · `jobs/processAIReply.ts:3543`)
- **Mechanism:** Phone resolves via contact.metadata (populated by the fail-open profile fetch at ingestion) → message extraction within the 40-message window → WhatsApp-only external_id fallback; each source's availability varies between executions and channels.
- **Manifests when:** Metadata absent/late; phone message scrolled out of the window; channel type difference.
- **Impact:** Order vs skip on the same logical conversation; FB skips where WhatsApp orders (correct/silence).
- **Determinism achievable:** Partially — durable extraction (persist the phone on the contact when first seen) removes window dependence; upstream fetch variance remains.
- **Management:** bound.
- **Confirmed root cause:** RC-13 (phone source chain vs history window), RC-22 (order field)

### Class 5 — Data-order (16 rows)

Unordered reads, global indexes shared across tenants, window-slide effects on nondeterministically-accumulated state, and tie-breaking on random ids.

#### DP-iq-03 — Batch dedupe key vs first-message-only processing (S-04 · `controllers/webhookController.ts:180`)
- **Mechanism:** The edge dedupe key concatenates ALL mids in the payload while normalization reads only the first message; messages 2..N are never persisted and any redelivery containing them dedupes against `webhook_seen` and is ACKed without enqueue.
- **Manifests when:** Meta batches multiple entries/messages into one POST (documented behavior under load).
- **Impact:** The same customer message replies when delivered alone but is silently lost when batched (correct/silence).
- **Determinism achievable:** Yes — per-message dedupe keys + processing every message in the payload.
- **Management:** eliminate.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-iq-07 — Channel resolution: LIMIT 1 with no ORDER BY (S-08 · `db/models/channel.ts:119`)
- **Mechanism:** Lookup by (type, external_id) without tenant filter; the unique constraint permits the same external_id under two tenants, and which row LIMIT 1 returns is planner/heap-order dependent.
- **Manifests when:** Same page/number/bot connected under more than one tenant (re-onboarding, agencies).
- **Impact:** Identical webhooks routed to different tenants — different catalog, config, reply (correct/wrong).
- **Determinism achievable:** Yes — deterministic ORDER BY plus an explicit disambiguation rule (or uniqueness at the platform level).
- **Management:** eliminate.
- **Confirmed root cause:** RC-09 (channel resolve LIMIT 1, no ORDER BY)

#### DP-iq-12 — app_id echo heuristic (S-11 · `services/webhookNormalizer.ts:92`)
- **Mechanism:** No app_id ⇒ human agent; app_id present ⇒ API send. Third-party tools on the same page produce app_id echoes classified `sent_by:'ai'` (no hold — Hillside replies on top of the other system); every Meta-native human reply sets sticky `human_replied` + hold. WhatsApp/Viber have no echo handling at all.
- **Manifests when:** Tenant staff or third-party bots active on the same page (FB/IG only).
- **Impact:** The conversation's future outcome class hinges on which surface the same human used (correct/wrong/silence).
- **Determinism achievable:** No — the platform does not supply a reliable origin signal at this stage; the heuristic is inherently under-informed.
- **Management:** detect+log (record classification basis; alert on suspected misclassification patterns).
- **Confirmed root cause:** RC-24 (app_id echo heuristic)

#### DP-pc-09 — 40-row history window slide (S-20 · `db/models/message.ts:313`)
- **Mechanism:** History is the most recent 40 rows; any extra persisted row between two executions (a retry's outbound, a canned ack, a human note) slides the window and can push a load-bearing fact (address, phone, allergy) out of the model's world entirely. The extra rows accumulate nondeterministically (guard firings, retries).
- **Manifests when:** Conversation at/over 40 rows with any row-count delta between executions.
- **Impact:** Same question answered with vs without a critical stated fact (correct/wrong/escalate).
- **Determinism achievable:** Partially — durable fact extraction (persisting order-relevant fields when first stated) bounds the impact; a finite window always slides.
- **Management:** bound.
- **Confirmed root cause:** RC-13 (40-row history window slide)

#### DP-pc-11 — UUID tie-break on equal created_at (S-20 · `db/models/message.ts:314`)
- **Mechanism:** `ORDER BY created_at DESC, id DESC` with random UUIDs: rows persisted in the same timestamp tick sort by UUID, not arrival — two logically identical conversations present the burst in different order.
- **Manifests when:** Two or more rows share created_at to timestamp precision.
- **Impact:** Different apparent question order; different summary previews (correct/wrong).
- **Determinism achievable:** Yes — a monotonic sequence column or platform-timestamp ordering.
- **Management:** eliminate.
- **Confirmed root cause:** RC-05 (UUID tie-break on equal created_at)

#### DP-GPR-13 — Reaction guard tests the merged burst with startsWith (S-21 · `jobs/processAIReply.ts:1354`)
- **Mechanism:** If the oldest message in the burst is a reaction placeholder and a real question follows in the same burst, the joined text starts with the reaction string and the entire burst is skipped; processed separately, the question would get a reply.
- **Manifests when:** Reaction followed by a text question with no outbound between, merged by timing.
- **Impact:** Real question silently dropped (correct/silence).
- **Determinism achievable:** Yes — evaluate the guard per message, not on the merged text.
- **Management:** eliminate.
- **Confirmed root cause:** RC-05 (reaction guard on the merged burst)

#### DP-GPR-33 — Emoji-only guard on merged text (S-21 · `jobs/processAIReply.ts:1358`)
- **Mechanism:** An emoji-only message merged with a text question is answered; the identical emoji alone (different timing → different burst) exits silently.
- **Manifests when:** Emoji-only inbound; presence of an unanswered text neighbor in the burst window.
- **Impact:** Timing-dependent silence for the same input (correct/silence).
- **Determinism achievable:** Yes — per-message evaluation.
- **Management:** eliminate.
- **Confirmed root cause:** RC-05 (emoji-only guard on merged text)

#### DP-retrieval-07 — Adaptive ef_search escalation depends on other tenants (S-34 · `db/models/product.ts:811`)
- **Mechanism:** The 100→500 retry fires only when the first pass under-fills, which depends on how many *other tenants'* rows crowd the global HNSW candidate pool — identical same-tenant requests diverge because a different tenant inserted products between them.
- **Manifests when:** Tenant's embedded rows a small fraction of the corpus; results ≈ limit boundary.
- **Impact:** Different candidate ordering → different post-threshold semantic set (correct/wrong).
- **Determinism achievable:** Partially — per-tenant partitioned indexes remove cross-tenant coupling; ANN ordering itself is not strictly guaranteed.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-retrieval-08 — Global HNSW index with tenant post-filter (S-34 · `db/models/product.ts:722`)
- **Mechanism:** A small tenant's correct product can fall outside the global top-500 candidates as the cross-tenant corpus grows; ANN composition also shifts as the graph mutates with other tenants' inserts.
- **Manifests when:** Large total corpus; tenant with few products; unusual query spelling leaving semantic as the only path.
- **Impact:** The right product silently never reaches fusion (correct/wrong/escalate).
- **Determinism achievable:** Partially — same structural remedy as retrieval-07; environmental growth otherwise guarantees drift over time.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-retrieval-11 — RRF fusion has no tie-breaker (S-35 · `services/aiService.ts:443`)
- **Mechanism:** Sort by float score with ties resolved by Map insertion order, which derives from source order and Postgres heap order; phraseDirect appends per-phrase results without dedup so one product receives multiple additive contributions at the slice boundary.
- **Manifests when:** Fused score ties/near-ties at the limit; multi-bigram messages hitting the same product.
- **Impact:** Which products enter the prompt differs between executions (correct/wrong).
- **Determinism achievable:** Yes — explicit deterministic tie-breaker (id) + per-source dedup.
- **Management:** eliminate.
- **Confirmed root cause:** RC-04 (RRF fusion tie ordering)

#### DP-retrieval-12 — Product-context anchor lost by window slide (S-36 · `jobs/processAIReply.ts:3211`, merged DP-po-29)
- **Mechanism:** Holding/escalation replies persist `product_ids: []`; a run of escalations/chatter pushes the last non-empty recommendation out of the 40-message scan and the deterministic anchor is silently lost — and since prior-turn guard escalations are themselves stochastic, identical current messages arrive anchor-present vs anchor-lost.
- **Manifests when:** Contextual follow-up after ≥40 messages without a product-bearing AI reply in-window.
- **Impact:** Follow-up demoted to the fragile anchor-regex/LLM chain (correct/wrong/escalate).
- **Determinism achievable:** Partially — persisting the current product context on the conversation row (not per message) removes the window dependence; interplay with guard stochasticity remains.
- **Management:** bound.
- **Confirmed root cause:** RC-13 (product-context anchor lost by window slide)

#### DP-pc-10 — Summary compression cliff (S-40 · `services/aiService.ts:3478`)
- **Mechanism:** Only the last 10 rows stay verbatim; older content is reduced to first/last 140-char previews + last 2 customer messages. A fact 9 messages from the end is verbatim; at 12 it survives only by luck of the previews. One nondeterministically-added message flips a fact across the cliff.
- **Manifests when:** Thread >10 messages; decision-relevant fact near the boundary.
- **Impact:** Same fact visible vs invisible to the model (correct/wrong).
- **Determinism achievable:** Partially — same family as pc-09: durable fact extraction bounds it; any compression boundary slides.
- **Management:** bound.
- **Confirmed root cause:** RC-13 (summary compression cliff)

#### DP-pc-12 — Truncation knife-edge evicts up to 7 messages (S-40 · `services/aiService.ts:4019`)
- **Mechanism:** The truncation loop drops oldest raw messages while estimated tokens exceed 6000; a few extra characters anywhere in the window (e.g., a slightly longer canned ack in a prior turn) tips the total and evicts a block of messages in one execution but none in the other.
- **Manifests when:** Raw-window+summary estimate straddling the budget.
- **Impact:** Materially different context for near-identical windows (correct/wrong).
- **Determinism achievable:** Partially — hysteresis/stable budgeting smooths the discontinuity; a budget boundary always exists.
- **Management:** bound (the truncation warn is the detection signal).
- **Confirmed root cause:** RC-13 (truncation knife-edge evicts messages)

#### DP-pc-14 — Unfiltered history feeds poisoned context (S-40 · `services/aiService.ts:3115`)
- **Mechanism:** Flagged replies (e.g., hallucinated_price), failed-send outbounds, and human turns all re-enter as role 'assistant'; whether the prior turn's guard fired (itself stochastic) determines whether today's identical request is answered against a poisoned or clean context.
- **Manifests when:** Any flagged/failed-send/human row within the 40-message window.
- **Impact:** The model treats its own flagged hallucination as established fact (correct/wrong).
- **Determinism achievable:** Yes — deterministic filtering/annotation of flagged and failed rows when building the array.
- **Management:** eliminate.
- **Confirmed root cause:** RC-16 (unfiltered history re-feeds flagged/undelivered replies)

#### DP-po-10 — WhatsApp retry semantics differ by channel (S-65 · `jobs/processAIReply.ts:3068`)
- **Mechanism:** WhatsApp's sender returns no message id so the send marker is the literal '1'; on a crash-after-persist retry, `priorGraphMessageId` is null and a SECOND outbound row is inserted with a fresh `ai_{uuid}` id, re-running S-66..S-73 (duplicate alerts/analytics). Channel type alone decides dead-letter (DP-po-09) vs duplicate-row.
- **Manifests when:** WhatsApp channel; retry after the outbound row persisted.
- **Impact:** Duplicate rows, duplicated billing-relevant events (correct/wrong).
- **Determinism achievable:** Yes — channel-uniform idempotent persistence keyed to the inbound message.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (WhatsApp retry inserts a duplicate row)

#### DP-po-16 — Billing bookkeeping fires before the send-failure branch (S-67 · `jobs/processAIReply.ts:3448`)
- **Mechanism:** `ai_reply_sent` analytics and the use-case eval enqueue execute before `!sendResult?.success` is checked; failed sends keep `sent_by='ai'` and count toward billability — a conversation where the customer never received any AI reply can become a billable use case. The 4h eval timer is also anchored to the *first* reply in the window.
- **Manifests when:** Channel send failure on any turn; multiple replies within 4h.
- **Impact:** Billing artifacts diverge from delivered reality (correct/wrong).
- **Determinism achievable:** Yes — ordering bookkeeping after the send outcome (and filtering billability on send_status) makes billing a deterministic function of delivery.
- **Management:** eliminate.
- **Confirmed root cause:** RC-22 (billing fires before the send-failure branch), RC-20 (delivery-state divergence)

### Class 6 — Config drift (9 rows)

Env values read at different lifetimes, absent from `.env.example`, or silently defaulted. Every row is eliminable with boot-time validation, a single read point, and a logged config fingerprint; divergence manifests nondeterministically only because job→worker assignment is scheduler-dependent.

#### DP-GPR-31 — Mixed env read lifetimes for gating knobs (S-16 · `jobs/processAIReply.ts:1227`)
- **Mechanism:** `AI_MAX_REPLIES_PER_HOUR` re-read per job and `HUMAN_HOLD_MINUTES` per call, while concurrency/lock-TTL/history-depth are frozen at module load — in a rolling deploy, identical messages run under different caps, hold windows, and history depths depending on the worker.
- **Manifests when:** Env change with partial restart, or heterogeneous worker instances.
- **Impact:** All four outcome classes reachable via history-depth and gate differences.
- **Determinism achievable:** Yes — uniform read lifetime + startup config log.
- **Management:** eliminate.
- **Confirmed root cause:** RC-06 (mixed env read lifetimes for gating knobs)

#### DP-pc-06 — DEFAULT_AI_CONFIG cached across onboarding (S-31 · `services/aiService.ts:220`)
- **Mechanism:** With no ai_configs row, the default config (is_active: true, no restrictions) is cached 900s; the real config created mid-window is ignored for up to 900s (onboarding performs no invalidation).
- **Manifests when:** AI ran for a tenant before its config row existed; row created inside the TTL.
- **Impact:** Replies without tenant tone/restrictions (correct/wrong).
- **Determinism achievable:** Yes — invalidate on onboarding completion.
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (DEFAULT_AI_CONFIG cached across onboarding)

#### DP-pc-08 — Locked-block self-heal at reply time (S-31 · `services/aiService.ts:243`)
- **Mechanism:** `forceSyncLockedBlocksForTenant` runs on every generateReply, silently overwriting divergent locked-block content mid-conversation; a reply holding the cached pre-heal blocks uses old text while the next uses healed text; a DB error here fails the whole reply job.
- **Manifests when:** Locked-block tenant content differs from catalog default; or DB error during the per-reply UPDATE.
- **Impact:** Prompt content flips between adjacent replies; reply-path availability coupled to a write (correct/wrong/silence).
- **Determinism achievable:** Yes — move the sync out of the reply path (event-driven on catalog change).
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (locked-block self-heal at reply time), RC-26 (prompt content)

#### DP-retrieval-22 — Embedding model/dimension drift (S-33 · `services/embeddingService.ts:12`)
- **Mechanism:** Code fallback `text-embedding-3-large` (3072-dim) vs schema `vector(1536)` with no dimensions param: a drifted/unset env makes every query vector dimension-incompatible — the similarity SQL errors are swallowed and the instance silently runs lexical-only forever.
- **Manifests when:** `OPENAI_EMBEDDING_MODEL` unset or changed between deploys/instances.
- **Impact:** One instance behaves permanently differently from its peers on identical requests (correct/wrong).
- **Determinism achievable:** Yes — boot-time dimension validation against the schema.
- **Management:** eliminate.
- **Confirmed root cause:** RC-04 (embedding model/dimension drift)

#### DP-retrieval-25 — HNSW ef_search knobs undocumented (S-34 · `db/models/product.ts:730`)
- **Mechanism:** `HNSW_EF_SEARCH`/`HNSW_EF_SEARCH_MAX` are per-process and the MAX is absent from `.env.example`; inconsistent values across instances change ANN candidate pools per worker.
- **Manifests when:** Env values differ across deployed instances.
- **Impact:** Different semantic source contents by worker affinity (correct/wrong).
- **Determinism achievable:** Yes — document + log at startup + validate consistency.
- **Management:** eliminate.
- **Confirmed root cause:** RC-04 (HNSW ef_search knobs drift)

#### DP-retrieval-10 — NULL-model legacy embedding rows admitted (S-34 · `db/models/product.ts:771`)
- **Mechanism:** The read-time model guard admits `embedding_model IS NULL` rows on the assumption they share the current model; if produced by a different same-dimension model, their distances are meaningless and they rank effectively randomly until the 6h reconcile re-stamps them.
- **Manifests when:** Pre-migration-045 rows or a model change with reconcile lag.
- **Impact:** Retrieval quality differs before vs after healing (correct/wrong).
- **Determinism achievable:** Yes — backfill model stamps + strict guard.
- **Management:** eliminate.
- **Confirmed root cause:** RC-04 (NULL-model legacy embedding rows admitted)

#### DP-retrieval-05 — SIMILARITY_THRESHOLD drift, historically real (S-35 · `services/aiService.ts:75`)
- **Mechanism:** Code comments document real drift (0.65 vs 0.75 both in circulation); at 0.75, correct products scoring 0.70–0.74 are silently discarded on the affected instances.
- **Manifests when:** Env differs between instances/deploys; products in the 0.65–0.75 band.
- **Impact:** Different semantic candidate sets per instance (correct/wrong).
- **Determinism achievable:** Yes — the startup log already exists; enforce consistency at deploy.
- **Management:** eliminate.
- **Confirmed root cause:** RC-04 (SIMILARITY_THRESHOLD drift)

#### DP-pc-20 — IIFE-frozen context/temperature constants (S-40 · `services/aiService.ts:92`)
- **Mechanism:** `CONTEXT_MAX_HISTORY_TOKENS`, `HISTORY_FETCH_LIMIT`, `AI_REPLY_TEMPERATURE` frozen at module load; during deploy overlap (25s shutdown window) or with divergent .env files, two processes serve the same tenant with different windows, budgets, and sampling temperature.
- **Manifests when:** Mixed-constant processes coexisting.
- **Impact:** Divergence purely by which process picks the job (correct/wrong).
- **Determinism achievable:** Yes — config fingerprint logging + deploy-time consistency check.
- **Management:** eliminate.
- **Confirmed root cause:** RC-06 (frozen constants), RC-03 (frozen AI_REPLY_TEMPERATURE)

#### DP-po-22 — INTENT_THRESHOLD silent fallback (S-70 · `jobs/processAIReply.ts:3523`)
- **Mechanism:** Parsed per-job with silent fallback to 0.85 for missing/invalid/out-of-range values (a legitimate '1' falls back); documented in CLAUDE.md but absent from `.env.example`; the threshold applied is never logged.
- **Manifests when:** Env divergence between workers, or operator values outside (0,1).
- **Impact:** Same conversation crosses the order gate on one deployment and not another (correct/wrong/silence).
- **Determinism achievable:** Yes — boot-time validation + logging the resolved threshold.
- **Management:** eliminate.
- **Confirmed root cause:** RC-08 (INTENT_THRESHOLD boundary), RC-22 (order gate)

### Class 7 — Error-fallback (36 rows)

The failure *occurrence* (Redis blip, OpenAI 5xx, DB deadlock, CDN error) is environmental and nondeterministic; what makes this class dangerous is that the *response* to failure is inconsistent — fail-open here, fail-closed there, swallow-and-continue elsewhere — so an identical infrastructure event lands in different outcome classes depending on which line it hits. Determinism of the failure-time behavior is broadly achievable even where the failure itself is not preventable.

#### DP-iq-28 — Edge dedupe SET has no try/catch (S-04 · `controllers/webhookController.ts:311`)
- **Mechanism:** A Redis outage makes the handler throw → 500 → platform retries with backoff; the message is processed late (against changed conversation state) or dropped by the platform.
- **Manifests when:** Redis unavailable at webhook receipt.
- **Impact:** Seconds vs minutes-to-hours vs lost, by Redis health (correct/silence).
- **Determinism achievable:** Partially — the outage is environmental; a durable intake path bounds the divergence to latency.
- **Management:** bound.
- **Confirmed root cause:** RC-21 (intake reliability — Redis at receipt, no try/catch)

#### DP-iq-04 — ACK 200 before fire-and-forget enqueue (S-05 · `controllers/webhookController.ts:336`)
- **Mechanism:** `res.sendStatus(200)` precedes `void enqueueInboundPayload()`; an enqueue failure is only console.error'd while the platform believes delivery succeeded and the 24h `webhook_seen` key blocks redelivery — unrecoverable loss.
- **Manifests when:** Transient Redis/BullMQ failure in the sub-second window after ACK (same pattern for Viber).
- **Impact:** Permanent, invisible message loss (correct/silence).
- **Determinism achievable:** Yes — enqueue-before-ACK (or durable intake + reconciliation) converges healthy and blip runs to eventual processing.
- **Management:** eliminate.
- **Confirmed root cause:** RC-21 (ACK 200 before fire-and-forget enqueue)

#### DP-iq-10 — Graph profile lookup fail-open (S-09 · `jobs/processInboundMessage.ts:504`)
- **Mechanism:** Profile fetches succeed or degrade to fallback labels ('IG user 123…'); the resolved name feeds conversation context and downstream `customer_name` resolution, with 10min/24h throttle windows suppressing refresh.
- **Manifests when:** Graph API availability/permission variance at first contact.
- **Impact:** Different stored names → potentially different order-field extraction later (correct/wrong).
- **Determinism achievable:** Partially — retryable backfill converges the stored name; the first-turn divergence window remains.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-iq-09 — Attachment pipeline fail-open to text-only (S-10 · `jobs/processInboundMessage.ts:689`)
- **Mechanism:** Per-attachment failures drop the attachment; if all fail the message persists text-only and the AI never enters the vision/image-match path. Viber media URLs expire after ~1h, so a delayed job deterministically loses the attachment.
- **Manifests when:** CDN/Graph/Cloudinary/Backblaze transients, or job delay past Viber's TTL.
- **Impact:** A product photo yields a text-only (often wrong/clarifying) reply (correct/wrong).
- **Determinism achievable:** Partially — retries and early fetch bound the loss; external TTLs are hard constraints.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-iq-29 — Retries re-upload attachments as new objects (S-10 · `jobs/processInboundMessage.ts:600`)
- **Mechanism:** Webhook-job retries re-run Graph fetches and uploads before the S-07 anchor exists; uploads are not attempt-scoped, so which attempt's URL set lands on the persisted row is attempt-dependent and orphans accumulate.
- **Manifests when:** Any webhook-job throw after uploads but before persist, followed by a successful retry.
- **Impact:** Stored `attachment_urls` vary by attempt; storage garbage (correct/wrong).
- **Determinism achievable:** Yes — attempt-scoped deterministic object keys (idempotent uploads).
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (retries re-upload attachments as new objects)

#### DP-iq-15 — Throw between persist and ai-enqueue strands the message (S-13 · `jobs/processInboundMessage.ts:893`)
- **Mechanism:** Any throw after the message row persists but before `aiQueue.add` succeeds fails the webhook job; on retry the S-07 dedupe finds the persisted row and returns early, never reaching the enqueue — the message is visible in the inbox but no AI job ever exists.
- **Manifests when:** Throw in the getJobs/remove/add sequence (the debounce remove() is inherently racy).
- **Impact:** Permanent silence that looks like the AI ignored the message (correct/silence).
- **Determinism achievable:** Yes — transactional-outbox-style enqueue keyed to the message id, plus a reconciliation sweep for persisted-but-unqueued messages.
- **Management:** eliminate.
- **Confirmed root cause:** RC-21 (throw between persist and ai-enqueue strands the message)

#### DP-iq-22 — Rate-limit pause+alert transaction failure (S-16 · `jobs/processAIReply.ts:1265`, merged DP-GPR-06)
- **Mechanism:** On breach, pause+alert run in one tx with catch → ROLLBACK → log; on tx failure the customer gets silence *without* `ai_paused` set and without any tenant-facing alert — after the counter TTL the AI silently resumes.
- **Manifests when:** DB error during the pause/alert tx at breach time.
- **Impact:** One hour of unexplained silence vs a visible acknowledged pause (escalate/silence).
- **Determinism achievable:** Partially — retrying the tx converges outcomes; DB failure occurrence is environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-18 (rate-limit pause+alert tx failure)

#### DP-GPR-17 — Cancel/refund detector transport failure drops the escalation (S-23 · `jobs/processAIReply.ts:1942`)
- **Mechanism:** No internal transport catch; an OpenAI timeout throws to the umbrella catch, which logs and continues normal flow — a customer explicitly demanding a refund receives an ordinary sales reply with no alert, no pause, no order flag, and no retry.
- **Manifests when:** OpenAI transport failure during the cancel/refund call.
- **Impact:** Silent loss of a mandatory escalation (wrong/correct).
- **Determinism achievable:** Partially — a uniform failure policy (retry or deterministic safe default) fixes the failure-time behavior; the outage is environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-19 (cancel/refund detector transport failure)

#### DP-GPR-18 — Ack delivered, then un-transactional writes fail (S-23 · `jobs/processAIReply.ts:1419`)
- **Mechanism:** The canned cancellation ack has no idempotency marker; a throw after delivery lands in the umbrella catch, which continues to generateReply — the customer receives the ack AND a normal AI reply while the pause, alerts, and order flags are lost.
- **Manifests when:** DB error between channel send and the pause/alert writes.
- **Impact:** Contradictory double reply plus lost escalation state (wrong).
- **Determinism achievable:** Yes — idempotency marker on the ack + transactional writes committed before/with the send decision.
- **Management:** eliminate.
- **Confirmed root cause:** RC-19 (ack delivered, then un-transactional writes fail)

#### DP-GPR-28 — Umbrella catch over the entire pre-reply block (S-23 · `jobs/processAIReply.ts:1942`)
- **Mechanism:** One try/catch (lines 1379–1948) wraps all special paths; any throw anywhere is downgraded to a warn and execution continues into generateReply — the exact failure line determines which partial side effects (sent acks, order flags, pauses) survive, and none are retried.
- **Manifests when:** Any exception inside lines 1379–1941.
- **Impact:** The escalation subsystem is fail-open as a unit; identical failures at different lines yield different outcome classes (all four classes).
- **Determinism achievable:** Partially — scoped error handling with one consistent policy per path makes failure-time behavior deterministic; occurrence is environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-19 (umbrella catch over the entire pre-reply block)

#### DP-GPR-32 — Synthetic external ids defeat ack dedupe (S-23 · `jobs/processAIReply.ts:1425`)
- **Mechanism:** Pre-reply canned sends persist with `graphMessageId ?? 'ai_'+randomUUID()` — a failed send yields a fresh synthetic id every execution so re-sent acks are undetectable; a duplicate real graphMessageId throws UNIQUE into the umbrella catch, converting a delivered ack into "continue normal flow" plus a second reply.
- **Manifests when:** Duplicate graphMessageId or partial prior attempt in a pre-reply path.
- **Impact:** Duplicate/contradictory customer messages (wrong/correct).
- **Determinism achievable:** Yes — deterministic idempotency keys per (inbound message, path).
- **Management:** eliminate.
- **Confirmed root cause:** RC-19 (synthetic ids defeat ack dedupe), RC-20 (idempotency)

#### DP-GPR-21 — Holding message sent despite failed escalation transaction (S-24 · `jobs/processAIReply.ts:1542`)
- **Mechanism:** In the wrong-product (and post-purchase) escalations, the pause + human_replied-reset + alert tx failure is caught and logged — but the code still sends and persists "a colleague will follow up"; the AI resumes on the next message and no human is ever notified.
- **Manifests when:** DB transaction failure during escalation writes.
- **Impact:** A promise to the customer with no operational backing (wrong/silence).
- **Determinism achievable:** Yes — order the send after the committed transaction; on failure, no promise is made.
- **Management:** eliminate.
- **Confirmed root cause:** RC-19 (holding message sent despite failed escalation tx)

#### DP-GPR-23 — Affirmation-detector throw abandons remaining branches (S-25 · `services/aiService.ts:2723`)
- **Mechanism:** `detectOrderAffirmationIntent` has no transport catch; a throw propagates to the umbrella catch, abandoning post-purchase, delivery-ETA, and order-info-update evaluation — which failure point in the serialized detector chain throws determines which subset of special paths ran.
- **Manifests when:** OpenAI transport failure on the affirmation call after earlier calls succeeded.
- **Impact:** A delivery complaint gets a generated sales reply instead of escalating (wrong/correct).
- **Determinism achievable:** Partially — per-detector failure policy makes the evaluated set deterministic; outage occurrence environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-19 (affirmation-detector throw abandons branches), RC-07

#### DP-pc-07 — Cache loaders throw on Redis outage (S-31 · `services/aiService.ts:203`)
- **Mechanism:** The loaders await Redis get/set with no try/catch — a Redis outage fails generateReply and the whole job into retry-then-silence, while corrupt cached JSON is handled fail-open with a DB fallback. Asymmetric failure classes for the same subsystem.
- **Manifests when:** Redis unavailable during generateReply cache loads.
- **Impact:** Redis up → reply; Redis flapping → no reply ever (correct/silence).
- **Determinism achievable:** Yes — fail-open to the DB read (the data's source of truth) converges both cases to a correct reply.
- **Management:** eliminate.
- **Confirmed root cause:** RC-17 (cache loaders throw on Redis outage)

#### DP-retrieval-02 — Embedding API error swallowed to lexical-only (S-33 · `services/aiService.ts:661`)
- **Mechanism:** Any embedding error is swallowed by a bare catch returning null; the request degrades to lexical-only fusion exactly as DP-retrieval-01 but on error.
- **Manifests when:** OpenAI error on a cache-miss embedding call resolving before the 5s timer.
- **Impact:** Different retrieval for one request and not the next (correct/wrong).
- **Determinism achievable:** Partially — same decomposition as retrieval-01.
- **Management:** bound (and log the discarded error — currently unlogged).
- **Confirmed root cause:** RC-04 (embedding API error swallowed to lexical-only)

#### DP-retrieval-09 — Vector-query DB error swallowed (S-35 · `services/aiService.ts:710`)
- **Mechanism:** Any `searchProductsBySimilarity` error (pool exhaustion, statement timeout, dimension mismatch) is caught bare, sets `semanticSkipped=true`, and continues lexical-only, with the underlying error discarded.
- **Manifests when:** DB-side failure specific to the vector query.
- **Impact:** Semantic-included vs lexical-only retrieval across adjacent requests (correct/wrong).
- **Determinism achievable:** Partially — retry/error surfacing bounds it; transients environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-04 (vector-query DB error swallowed)

#### DP-retrieval-24 — Asymmetric failure classes across retrieval routes (S-36 · `services/aiService.ts:3651`)
- **Mechanism:** Fresh-search and other-options calls fail open to `products=[]` (guardrail reply), but the contextual-resolver calls are unwrapped — a DB error there propagates, the job retries/fails, and the customer gets silence instead of a degraded reply. Which failure class a transient produces depends on which routing branch the classifiers selected.
- **Manifests when:** Transient DB error during retrieval on the contextual (unwrapped) path.
- **Impact:** Silence vs degraded reply for the same infrastructure event (correct/wrong/silence).
- **Determinism achievable:** Partially — uniform failure policy across routes removes the class asymmetry; occurrence environmental.
- **Management:** eliminate (the asymmetry; the residual degradation is bounded).
- **Confirmed root cause:** RC-04 (asymmetric failure classes across retrieval routes)

#### DP-pc-21 — Packaging-derived context silently omitted (S-38 · `services/aiService.ts:3863`)
- **Mechanism:** `getProductImageDerivedContext` failure only warns: the "Verified packaging details" extension and its dependent system append are omitted, shrinking the model's knowledge base for that turn.
- **Manifests when:** Transient DB error on a turn whose answer lives only in packaging data.
- **Impact:** Answered from the label vs "I don't have that detail" / gap escalation (correct/wrong/escalate).
- **Determinism achievable:** Partially — retry converges; transients environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-01 (omitted packaging context → gap escalation)

#### DP-iq-26 — BullMQ retry re-runs the entire pipeline (S-42 · `jobs/processAIReply.ts:1148`, merged DP-gg-04)
- **Mechanism:** Retries (3 attempts + stall re-execution) re-run everything from S-14: every classifier re-rolls (attempt 2 can route down a different pre-reply path than attempt 1), the rate counter INCRs again, special-path alerts duplicate, and the canned cancellation ack has no idempotency marker so the customer receives it twice. Only the main send, image sends, use-case enqueue, and draft-order guard are attempt-safe.
- **Manifests when:** Any throw after a customer-visible or DB side effect but before completion.
- **Impact:** Duplicate acks/alerts; different routing across attempts (correct/wrong/escalate).
- **Determinism achievable:** Partially — full side-effect idempotency and verdict persistence converge retries; the underlying classifier stochasticity is tracked separately.
- **Management:** bound.
- **Confirmed root cause:** RC-20 (BullMQ retry re-runs the pipeline), RC-19 (duplicate pre-reply acks)

#### DP-iq-27 — Exhausted retries vanish silently (S-42 · `jobs/failureHandler.ts:86`)
- **Mechanism:** When all 3 ai.reply attempts exhaust, the job lands in the failed set: no tenant-facing alert, no customer message, no requeue, no DLQ — only a prod ops webhook (and only if `ALERT_WEBHOOK_URL` is set).
- **Manifests when:** Failure persisting across the ~70s retry envelope.
- **Impact:** Invisible permanent silence for both customer and merchant (correct/silence).
- **Determinism achievable:** Partially — outage occurrence environmental; visibility and replay (DLQ + tenant alert) are fully implementable.
- **Management:** detect+log (make permanent failure a first-class, tenant-visible event with replay).
- **Confirmed root cause:** RC-20 (exhausted retries vanish; no DLQ)

#### DP-gg-12 — Usage-escalation tx failure sends the ungrounded reply (S-45 · `jobs/processAIReply.ts:2039`)
- **Mechanism:** Variants A/B do pause + human_replied reset + alert + reply replacement in one tx; on failure they ROLLBACK and keep the ORIGINAL reply — an intended escalation becomes the ungrounded answer with AI still active.
- **Manifests when:** Guard fired AND the transaction fails.
- **Impact:** Outcome class flips from escalate to wrong on infrastructure error alone.
- **Determinism achievable:** Partially — retry or fail-to-holding policy makes the failure branch deterministic; occurrence environmental.
- **Management:** eliminate (the escalate→wrong downgrade; never send the assessed-bad reply on tx failure).
- **Confirmed root cause:** RC-01 (usage-escalation tx failure sends ungrounded reply), RC-02

#### DP-gg-14 — Gap assessor is the only fail-closed guard (S-48 · `services/productInformationGapService.ts:105`)
- **Mechanism:** On empty context, empty response, parse error, or transport error it returns `ok:false` and the caller escalates — during any OpenAI degradation window, EVERY product-information question is replaced with a holding message, paused, and alerted, even ones the catalog answers completely.
- **Manifests when:** Assessor call fails or returns unparseable output.
- **Impact:** Mass escalation during outages; polarity opposite to every sibling guard (escalate).
- **Determinism achievable:** Partially — a uniform, deliberate outage policy across guards makes degradation behavior deterministic; the outage is environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-01 (gap assessor is the only fail-closed guard)

#### DP-gg-16 — Attribute classifier fail-open *increases* escalation (S-48 · `jobs/processAIReply.ts:2325`)
- **Mechanism:** `detectSpecifiedAttributes` fails open to an empty availableKeys set, so `computeMissingStructuredAttributes` may flag an attribute the catalog actually states, forcing a partial/holding replacement of a fully correct reply.
- **Manifests when:** Requested attribute value outside the regex vocabulary; classifier timeout/error.
- **Impact:** Correct reply replaced by escalation on classifier failure (correct/escalate).
- **Determinism achievable:** Partially — deterministic catalog-side attribute derivation shrinks reliance on the classifier.
- **Management:** bound.
- **Confirmed root cause:** RC-02 (attribute over-escalation on classifier failure), RC-25 (dialect attribute vocab)

#### DP-gg-17 — Image-derived knowledge omitted from gap assessment (S-48 · `jobs/processAIReply.ts:2307`)
- **Mechanism:** A failed fingerprint fetch is caught and the "Verified packaging details" block omitted; the fail-closed assessor then judges answerability against a smaller knowledge base, triggering a gap escalation that would not fire when the fetch succeeds.
- **Manifests when:** Answer-relevant fact exists only in image-derived context; fetch fails.
- **Impact:** Spurious gap escalation (correct/escalate).
- **Determinism achievable:** Partially — retry converges.
- **Management:** bound.
- **Confirmed root cause:** RC-01 (image-derived knowledge omitted → spurious gap escalation)

#### DP-gg-18 — Gap-escalation tx failure sends the assessed-incomplete reply (S-48 · `jobs/processAIReply.ts:2457`)
- **Mechanism:** The pause+alert+replace tx ROLLBACKs on failure and the reply stays unchanged — the original answer, already assessed incomplete/ungrounded, is sent with no pause and no alert.
- **Manifests when:** shouldEscalate true AND tx failure.
- **Impact:** Escalate downgraded to possibly-wrong (wrong/escalate).
- **Determinism achievable:** Partially — same remedy as DP-gg-12.
- **Management:** eliminate (the downgrade path).
- **Confirmed root cause:** RC-01 (gap-escalation tx failure), RC-02

#### DP-po-01 — Send-idempotency read fails open (S-62 · `jobs/processAIReply.ts:3065`)
- **Mechanism:** The `ai_send_done` read swallows Redis errors and reports "not sent"; on a retry during a Redis outage the send re-executes and the customer receives the reply twice.
- **Manifests when:** Retry coinciding with a Redis error on the marker read.
- **Impact:** Duplicate delivery (correct/wrong).
- **Determinism achievable:** Yes — DB-anchored idempotency (the persisted outbound row) instead of a fail-open ephemeral marker.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (send-idempotency read fails open)

#### DP-po-05 — Channel send failure is terminal (S-63 · `services/channelSenderService.ts:326`)
- **Mechanism:** `sendMessage` catches everything and returns `{success:false}`; the job completes successfully and BullMQ never re-attempts delivery — a transient network blip produces permanent silence plus an alert, while the identical request a second later delivers.
- **Manifests when:** Any channel-send exception or non-success response.
- **Impact:** Permanent silence on transients; failed row is terminal state (correct/silence/escalate).
- **Determinism achievable:** Partially — a delivery retry policy converges transients; hard channel failures remain environmental.
- **Management:** bound (the `message_send_failed` alert is the detection signal).
- **Confirmed root cause:** not elevated to a root cause — see appendix B

#### DP-po-07 — Marker write failure re-delivers (S-63 · `jobs/processAIReply.ts:3103`)
- **Mechanism:** The post-send marker SET swallows Redis errors; if it fails and a later step throws, the retry sees no marker and re-delivers.
- **Manifests when:** Redis error on the SET plus a subsequent job failure.
- **Impact:** Duplicate delivery, invisible in logs (correct/wrong).
- **Determinism achievable:** Yes — same DB-anchored idempotency as DP-po-01.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (marker write failure re-delivers)

#### DP-po-08 — All-or-nothing image-send marker (S-64 · `jobs/processAIReply.ts:3178`)
- **Mechanism:** The `ai_img_sent` marker is written only when ALL images succeeded; a partial failure leaves no marker so a retry re-sends every image including delivered ones; the read also fail-opens on Redis error.
- **Manifests when:** Multi-image turn with one failure + retry, or Redis outage on the read.
- **Impact:** Duplicate images in the thread (never persisted as rows, so invisible in the DB) (correct/wrong).
- **Determinism achievable:** Yes — per-image idempotency markers.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (all-or-nothing image-send marker)

#### DP-gg-27 — Post-send guards pause AFTER sending (S-66 · `jobs/processAIReply.ts:3272`)
- **Mechanism:** Price/name/uncertain escalations send the holding message first and do pause+alert after persist in a separate tx; if it fails, the customer was promised a specialist but no alert exists and `ai_paused` stays false — the next inbound gets a fresh AI attempt. Contrast: usage/gap guards pause pre-send atomically.
- **Manifests when:** Post-send guard fired AND the alert/pause tx fails.
- **Impact:** Promise with no follow-through; guard-family asymmetry (escalate/wrong).
- **Determinism achievable:** Partially — aligning all guards on commit-before-send removes the asymmetry; tx failure environmental.
- **Management:** eliminate (the ordering asymmetry).
- **Confirmed root cause:** RC-02 (post-send guard pause asymmetry)

#### DP-po-13 — Independently-committed alert+pause pairs (S-66 · `jobs/processAIReply.ts:3255`)
- **Mechanism:** Each hallucination/uncertain/quality alert+pause pair commits in its own BEGIN/COMMIT inside try/catch; a failed pair means the replaced message was sent but no pause is set and no alert created — the business is never notified.
- **Manifests when:** DB error during any of the four pairs after the send succeeded.
- **Impact:** AI keeps replying where an identical healthy execution pauses and escalates (correct/wrong).
- **Determinism achievable:** Partially — one transaction (or retried saga) for the guard outcome converges state; failure environmental.
- **Management:** eliminate (the partial-commit structure).
- **Confirmed root cause:** RC-02 (independently-committed alert+pause pairs)

#### DP-po-15 — Fire-and-forget use-case evaluation enqueue (S-67 · `jobs/processAIReply.ts:3461`)
- **Mechanism:** The 4h use-case eval enqueue is void-unawaited; a Redis/queue rejection is silently discarded — the same conversation is either billed as an AI use case or never evaluated. The `ai_reply_sent` logEvent shares the pattern.
- **Manifests when:** Redis unavailable or queue rejection at bookkeeping time.
- **Impact:** Billing-affecting silent divergence (correct/silence).
- **Determinism achievable:** Yes — awaited enqueue + reconciliation sweep makes evaluation guaranteed.
- **Management:** eliminate.
- **Confirmed root cause:** RC-22 (fire-and-forget use-case eval enqueue)

#### DP-po-12 — Self-healed retry row marked 'failed' with a fabricated reason (S-68 · `jobs/processAIReply.ts:3473`)
- **Mechanism:** On an alreadySent retry, `sendResult` stays null so `!sendResult?.success` is true: the row is marked `send_status='failed'` with fallback reason 'Contact not found for conversation' and a spurious `message_send_failed` alert fires — for a message the customer actually received.
- **Manifests when:** Retry after successful send + pre-persist crash; or genuinely missing contact.
- **Impact:** False failure records and alerts contaminating operational signal (correct/escalate).
- **Determinism achievable:** Yes — carry the prior attempt's send outcome through the marker.
- **Management:** eliminate.
- **Confirmed root cause:** RC-20 (self-healed retry row marked false-failure)

#### DP-po-18 — Draft-order block swallows detector throws (S-69 · `jobs/processAIReply.ts:3831`)
- **Mechanism:** `detect()` throws on empty completions/API failure, but the block's catch swallows it, the job succeeds, and the draft order is silently never created [E27] — a genuine order loses its row and its 5% commission with only a console.error.
- **Manifests when:** Empty/malformed completion or exhausted SDK retries inside lines 3510–3830.
- **Impact:** Revenue-bearing silent drop (correct/silence).
- **Determinism achievable:** Partially — a retryable order-detection sub-job converges transients; occurrence environmental.
- **Management:** bound.
- **Confirmed root cause:** RC-22 (draft-order block swallows detector throws)

#### DP-po-19 — Malformed intent JSON indistinguishable from low intent (S-69 · `services/intentDetectionService.ts:47`)
- **Mechanism:** `parseIntentJson` returns EMPTY_INTENT_RESULT (score 0) on unparseable JSON, silently converting an order-ready turn into a validation-gate skip.
- **Manifests when:** Model returns non-JSON (truncation at max_tokens 512, provider glitch).
- **Impact:** Lost order, indistinguishable in outcome from genuine low intent (correct/silence).
- **Determinism achievable:** Partially — retry-on-parse-failure converges most cases; provider glitches environmental.
- **Management:** detect+log (parse failures must be distinguishable from low-intent verdicts in telemetry).
- **Confirmed root cause:** RC-22 (malformed intent JSON indistinguishable from low intent)

#### DP-GPR-34 — Lock/slot release failures swallowed in finally (S-74 · `jobs/processAIReply.ts:3844`)
- **Mechanism:** Both releases swallow Redis errors: a failed lock release serializes the conversation behind a dead lock for up to 300s; a failed slot DECR shrinks the tenant's effective concurrency until the counter TTL.
- **Manifests when:** Redis error at job completion.
- **Impact:** Deferred replies on re-add loops whose fresh jobs the debounce can remove — delayed reply to lost job (correct/silence).
- **Determinism achievable:** Partially — TTL-based self-healing already bounds it; release retries narrow the window; occurrence environmental.
- **Management:** bound.
- **Confirmed root cause:** not elevated to a root cause — see appendix B

---

## Deterministic but fragile

These 9 register rows are pure functions of their direct inputs — holding input and state fixed, repeated executions always produce the same outcome. They are excluded from the nondeterminism inventory but recorded here because they *amplify* upstream variance into outcome-class flips or degrade silently, and several are correctness defects in their own right.

| id | step | location | fragility |
|---|---|---|---|
| DP-iq-01 | S-03 | `controllers/webhookController.ts:303` | Static fail-open: payloads without a timestamp always pass the freshness gate (`eventEpochMs ?? Date.now()` → skew always 0). Outcome is payload-shape-determined, never varies run-to-run. |
| DP-iq-05 | S-06 | `jobs/processInboundMessage.ts:436` | Static per-channel asymmetry: the same malformed message payload is silently dropped on Meta channels but escalates to ops on Viber — outcome class determined by channel, deterministic per input. |
| DP-iq-06 | S-07 | `db/models/message.ts:290` | Deterministic cross-tenant dedupe collision: a globally-scoped `external_message_id` lookup always drops the inbound when any tenant holds a colliding row. |
| DP-GPR-11 | S-20 | `jobs/processAIReply.ts:297` | Jaccard ≥ 0.82 knife-edge in burst dedup: a pure text function; amplifies upstream burst-composition variance into duplicated-question prompts but injects none of its own. |
| DP-pc-13 | S-40 | `services/aiService.ts:4009` | Three inconsistent token measures of the same message (add-estimate vs removal-subtraction vs actual array content): deterministic over/under-truncation given the window. |
| DP-pc-19 | S-39 | `services/promptAssemblyService.ts:89` | Permanent config defect: the orphan `guidelines.offers_promotions` block is injected for every tenant seeded before its catalog deactivation and never for tenants seeded after — deterministic per tenant, forever. |
| DP-retrieval-06 | S-35 | `services/aiService.ts:725` | Structural retrieval-mode flip on a 0-vs-1 `categoryTagMatches` boundary: deterministic given catalog + message; one tag edit flips the whole mode, but identically for every execution. |
| DP-retrieval-21 | S-36 | `services/aiService.ts:3777` | Outcome-class amplifier: with `products=[]`, a deterministic keyword count decides product-answer-from-sample vs clarify-guardrail — converting every marginal upstream retrieval difference into a categorical reply flip. |
| DP-gg-31 | S-42 | `services/aiService.ts:4139` | Guard-suite bypass: `matchedProducts` emptied on the full-catalog fallback deterministically disables the price/name/usage/gap guards for that path — the same wrong price is blocked on one path and passes unchecked on the other. |

These rows are prime Phase 16 hardening candidates precisely *because* they are deterministic: a fix changes behavior predictably, with no residual variance to manage.

---

## Inventory statistics

**Register:** 160 deduplicated rows → **151 in the nondeterminism inventory**, **9 deterministic-but-fragile** (excluded from the inventory, listed above).

### By nondeterminism type (inventory rows)

| type | rows | share |
|---|---:|---:|
| llm-stochastic | 42 | 27.8% |
| error-fallback | 36 | 23.8% |
| timing | 21 | 13.9% |
| concurrency | 17 | 11.3% |
| data-order | 16 | 10.6% |
| cache-staleness | 10 | 6.6% |
| config-drift | 9 | 6.0% |
| **total** | **151** | 100% |

### By determinism achievability (inventory rows)

| achievability | rows | share | reading |
|---|---:|---:|---|
| **yes** | 59 | 39.1% | Fully achievable at the stage: idempotency keys, ordering fixes, versioned invalidation, uniform failure policies, config validation. No residual variance once fixed. |
| **partially** | 88 | 58.3% | The decision *structure* (thresholds, persistence, retry reuse, failure polarity, windows) can be made deterministic; a residual variance source (LLM verdict, external timing, infrastructure failure occurrence, load) remains. |
| **no** | 4 | 2.6% | DP-gg-01 (provider-side sampling non-determinism), DP-iq-16 (any fixed debounce has a boundary), DP-iq-12 (platform provides no reliable echo-origin signal), DP-retrieval-13 (legitimate catalog state change between turns). |

### Achievability × type

| type | yes | partially | no |
|---|---:|---:|---:|
| llm-stochastic | 6 | 35 | 1 |
| error-fallback | 12 | 24 | 0 |
| timing | 8 | 12 | 1 |
| concurrency | 10 | 6 | 1 |
| data-order | 9 | 6 | 1 |
| cache-staleness | 5 | 5 | 0 |
| config-drift | 9 | 0 | 0 |
| **total** | **59** | **88** | **4** |

### By management approach (inventory rows)

| approach | rows | share |
|---|---:|---:|
| eliminate | 65 | 43.0% |
| bound | 79 | 52.3% |
| detect+log | 5 | 3.3% |
| accept | 2 | 1.3% |

### By confirmed-root-cause linkage (inventory rows)

Cross-linking each inventory row to the Phase 11 confirmed/weakened ledger (RC-01…RC-26, minus refuted RC-12). This is a *coverage* view, not a recategorization: the type / achievability / management columns above are per-row properties and did not change when the RC mapping was applied.

| linkage | rows | share |
|---|---:|---:|
| linked to ≥1 confirmed/weakened root cause | 139 | 92.1% |
| not elevated to a root cause (refuted or narrowed away in Phase 11) | 12 | 7.9% |
| **total** | **151** | 100% |

- **Distinct root causes that a nondeterminism-inventory row rolls up into: 23** of the 25 survivors (RC-01–RC-11, RC-13, RC-15–RC-22, RC-24–RC-26). The two survivors with **no** inventory row are **RC-14** (no AI auto-resume — a deterministic amplifier: it makes upstream variance *terminal* but injects none itself) and **RC-23** (CI/CD gate gap — a delivery-pipeline defect with no runtime decision point). Both weakened retrieval RCs (**RC-04**, **RC-09**) and the weakened quality RC (**RC-15**) still carry inventory rows and appear in the bridge below.
- **The 12 not-elevated rows** are: `DP-iq-20`, `DP-GPR-04`, `DP-iq-25`, `DP-GPR-34` (conversation-lock / tenant-fairness-slot / hold-reschedule machinery — no Phase 11 RC covers the lock subsystem; the per-conversation rate counter `DP-iq-21`→RC-18 and the retry re-add `DP-iq-19`→RC-20 *are* linked); `DP-po-05`, `DP-po-06` (terminal channel-send failure / outbound token-bucket); `DP-retrieval-07`, `DP-retrieval-08` (global-HNSW cross-tenant candidate-pool coupling); `DP-retrieval-20` (120s greeting-path catalog cache); `DP-iq-03` (batched-message 2..N loss); `DP-iq-09` (attachment pipeline fail-open to text-only); `DP-iq-10` (Graph profile fail-open name). Each is a code-confirmed mechanism that Phase 11 did not promote to a standalone root cause; they are retained here (not deleted) and remain Phase 16 hardening candidates. See appendix B (unconfirmed / non-elevated hypotheses).

### Observations

1. **Only 4 of 151 rows are irreducibly nondeterministic.** The system's run-to-run divergence is overwhelmingly *engineered-in*, not inherent to using an LLM: 39% of rows are fully eliminable with mechanical fixes, and another 58% can have their decision structure made deterministic even where a stochastic verdict or environmental failure remains inside.
2. **The one irreducible root (DP-gg-01) is amplified rather than contained.** Sampled reply text feeds ~15 downstream guards and classifiers whose own thresholds, exemptions, and failure polarities are inconsistent — so a single wording flip cascades into different outcome classes. Containment of that cascade (uniform guard structure) is the highest-leverage "partially" work.
3. **Failure-polarity inconsistency is a determinism problem, not just a robustness problem.** The 36 error-fallback rows show the same infrastructure event mapping to answer, silence, escalation, or duplicate delivery depending on which line it hits (fail-open vs fail-closed vs swallow). Choosing one polarity per subsystem converts environmental nondeterminism into predictable degradation.
4. **All 10 config-drift rows are eliminable** (boot-time validation, single read lifetime, logged config fingerprint) — the cheapest full-class elimination in the inventory. All 9 config-drift inventory rows plus DP-pc-19 (deterministic-but-fragile) belong to the same remediation batch.
5. **Billing-relevant nondeterminism concentrates at the tail of the pipeline** (S-62…S-73: DP-po-09/10/12/15/16/18/26/27/28, DP-gg-07): commission and use-case outcomes currently depend on send-marker TTLs, fire-and-forget enqueues, NOW()-relative windows, and classifier re-rolls. Every one of these is classified yes or partially — revenue determinism is achievable.
6. **Cross-linking confirms the inventory is a faithful decomposition of the root-cause set, not a parallel taxonomy.** 92% of inventory rows roll up into a confirmed/weakened root cause, and every confirmed root cause with a run-to-run-variance component (23 of 25 survivors) is grounded in at least one concrete decision point here. The two exceptions are structural, not stochastic (RC-14 amplifier; RC-23 pipeline). The severity bridge below inverts the mapping so Phase 16 can prioritize by root-cause severity while reading achievability off the inventory.

Concrete remediation designs for all "yes" rows and the deterministic-decision-structure work for "partially" rows are Phase 16 scope.

---

## Determinism achievability vs root-cause severity

This section inverts the per-row cross-links above into a per-root-cause view — the bridge Phase 16 uses to sequence remediation. It lists every confirmed/weakened root cause **that has a nondeterminism component** (i.e., at least one nondeterminism-inventory row rolls up into it), with its Phase 11 severity, the dominant nondeterminism type it introduces, whether determinism is achievable at that stage (aggregated from the member rows; classification-level only — implementation is Phase 16), and the management category.

Reading: **severity** ranks *business harm*; **achievable** ranks *how cleanly the variance can be removed*. The highest-leverage Phase 16 work is the top-left quadrant — high severity **and** achievable = yes.

| RC-id | Severity | Dominant nondeterminism type | Determinism achievable | Management category | Bridge note |
|---|---|---|---|---|---|
| RC-01 | Critical | llm-stochastic (fail-closed escalation assessor) | partial | bound | Verdict is stochastic; the fail-closed→deliberate-policy flip and per-turn persistence are eliminable structure. |
| RC-02 | Critical | llm-stochastic guard × data-order (per-turn retrieval window) | partial | bound | Validating guards against the **full tenant catalog** removes the wrong-reference-set false positives; residual is RC-03 wording. |
| RC-03 | High | llm-stochastic (temp-0.3 sampling) | no | accept | The one irreducible root — provider non-bit-determinism. Manage by bounding downstream guard consequences + recording temp/seed/model. |
| RC-04 | High (weakened) | timing / error-fallback (5s embedding race) | partial | bound | Caching timed-out queries makes repeats deterministic; first-call latency exposure is external. |
| RC-05 | High | timing (8s debounce / burst composition) | partial | bound | Per-conversation FIFO + platform-timestamp ordering eliminates most; the fixed debounce boundary (DP-iq-16) is irreducible → accept. |
| RC-09 | High (weakened) | data-order (unscoped `LIMIT 1`, no `ORDER BY`) | yes | eliminate | Global UNIQUE `(type, external_id)` + deterministic `ORDER BY` makes resolution single-valued. Latent in dev (0 channel rows). |
| RC-13 | High | data-order (40-row window + anchor slide) | partial | bound | A durable structured fact/anchor store bounds the loss; a finite window always slides. |
| RC-19 | High | error-fallback (umbrella catch fail-open as a unit) | partial | bound | Per-detector scoped catch with one explicit fail-*closed*-to-escalate policy + re-throw for retry; failure occurrence is environmental. |
| RC-20 | High | concurrency (non-idempotent BullMQ retry) | yes | eliminate | Idempotent persist keyed to the inbound message (ON CONFLICT + resume); send+persist as one idempotent unit. |
| RC-21 | High | concurrency / error-fallback (persist-then-no-enqueue) | yes | eliminate | Transactional-outbox enqueue + dedupe re-check for a missing `ai.reply` job. |
| RC-06 | Medium | timing (gates/knobs read at job-run time) | partial | bound | Snapshot gate/config state at receipt into the job payload; toggles racing receipt remain a real-time race. |
| RC-07 | Medium | llm-stochastic (missing-confidence code policy) | yes | eliminate | Uniform missing-confidence policy across all five detectors — a pure code decision, not a model property. |
| RC-08 | Medium | llm-stochastic (fixed confidence boundaries) | partial | bound | Threshold hysteresis + persisted per-message verdicts remove re-roll flips; first-pass boundary variance is irreducible. |
| RC-10 | Medium | llm-stochastic (language decision) | partial | bound | Pin locale per conversation (channel/contact locale first); first-detection variance on truly ambiguous text remains. |
| RC-11 | Medium | timing (webhook freshness skew) | partial | bound | Dedupe-based replay protection instead of skew-403; platform latency is external. |
| RC-15 | Medium (weakened) | llm-stochastic (eval jitter) × config-drift (threshold) | partial | bound | Threshold unification + error policy are deterministic; the eval score itself is stochastic. |
| RC-16 | Medium | data-order (unfiltered history re-feed) | yes | eliminate | Deterministically exclude/annotate `flagged` and non-delivered rows when building the message array. |
| RC-17 | Medium | cache-staleness (config/persona/model drift) | yes | eliminate | Versioned invalidation covering all mutation paths + persist model id on the message row. |
| RC-18 | Medium | concurrency (rate counter INCR pre-gate) | yes | eliminate | Count only delivered replies (idempotent per message id, post-send). |
| RC-22 | Medium | llm-stochastic × timing (intent / commission) | partial | bound | Commission from stored ordered timestamps (not `NOW()`) is eliminable; the 7-conjunct intent extraction stays stochastic. |
| RC-24 | Medium | cache-staleness / data-order (self-echo) | partial | bound | Durable send-id / content-hash record removes the Redis-TTL dependence; IG's missing `app_id` is a platform information limit. |
| RC-25 | Medium | llm-stochastic (English classifiers over dialect) | partial | bound | Dialect-normalized input + Albanian/Gheg corpus + rendered restrictions footer; residual classifier variance remains. |
| RC-26 | Medium | config-drift (prompt assembly; mostly deterministic-fragile) | yes | eliminate | Remove the orphan `offers_promotions` block, token-budget the system prompt, reconcile rule/guard contradictions. |

**Not in this table (no nondeterminism component):**
- **RC-14** (High, no AI auto-resume) — a **deterministic amplifier**. A paused conversation stays paused on every run; RC-14 injects no variance, it converts *upstream* variance (RC-01/RC-02/RC-08 escalations, RC-18 rate pause) into a permanent silent dead-end. Achievability *of the fix* is **yes** (auto-resume policy + invariant check), management **eliminate** — but it is not a source of run-to-run divergence, so it carries no inventory row.
- **RC-23** (Medium, CI/CD gate gap + migration ordering) — a delivery-pipeline / process defect with no runtime decision point. Fully **yes / eliminate** (gate deploy on CI, add `npm test`, number-order migrations with an advisory lock) but outside the runtime nondeterminism model.

**Quadrant summary for Phase 16 sequencing.** Severity-High-and-fully-achievable (do first): **RC-09, RC-20, RC-21** (plus amplifier RC-14 and process RC-23, both yes/eliminate). Severity-Critical-but-partial (structural containment, highest cascade leverage): **RC-01, RC-02**, gated by the irreducible **RC-03 (no / accept)**. Medium-and-fully-achievable (cheap mechanical wins): **RC-07, RC-16, RC-17, RC-18, RC-26**. Everything else is bound: make the decision *structure* deterministic and manage the residual stochastic verdict or environmental failure.




