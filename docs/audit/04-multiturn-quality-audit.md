# Phase 4 — Conversation Quality & Multi-Turn Behavior Audit (Issue 2)

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts). Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md for verbatim query evidence.

---

## Method

**Timeline reconstruction.** Per-conversation timelines were rebuilt from the `messages` table: `ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY created_at)` assigns turn indices; each turn carries `sent_by`, content, `flagged`, `quality_score`, `jsonb_array_length(product_ids)`, and inter-message gap (EV-018). Alerts were joined onto turns by `message_id` or by ≤120 s created_at proximity within the same conversation (EV-020, EV-023). The 32 resulting timeline JSONs (25 multi-turn + 7 alert-only conversations) live in the session scratchpad `audit/timelines/<conversation_id>.json` and are the source of all quoted turns below.

**Window-boundary math is a reconstruction, not logging.** The system does not persist what history/context the model actually saw for any given reply — there is no prompt log. Window positions were therefore *computed positionally* from the code constants that shape context assembly: `HISTORY_FETCH_LIMIT` default **40** (`backend/src/services/aiService.ts:108-112`), `RECENT_RAW_HISTORY_MESSAGES = 10` (`aiService.ts:98`), and `CONTEXT_MAX_HISTORY_TOKENS` default **6000** (`aiService.ts:92-97`). EV-021 applies the raw-10 window shape to every AI turn in >10-message conversations; statements like "the first product answer had left the window" are positional inferences from these constants, not observed prompt contents. Token-budget truncation (6000-token history budget) could bite earlier than the positional bound in verbose conversations — this analysis cannot see that, only bound it.

**Dev-data caveat.** All 46 conversations belong to a single tenant (`02beb134`, EV-017) and are team test conversations (recurring tester identity "Adem … Bregu i diellit, banesat e bardha blloku 35" across orders — EV-018). Counts below characterize *which failure modes the mechanisms produce*, not how often they would occur in production traffic. Where a rate is stated it is a dev-data rate only.

---

## Multi-turn trace samples

Six representative conversations, traced turn-by-turn. Quoted content is verbatim from EV-018 / the timeline JSONs (trimmed). `np` = `jsonb_array_length(messages.product_ids)` on the AI turn (the persisted product anchor).

### Trace 1 — `fcd0af7e` (timeline `fcd0af7e-….json`): the AI's own recommendation stripped as a "hallucination"

| turn | sender | content (trim) | np | note |
|---|---|---|---|---|
| 1 | customer | "a keni produkte te mira per shtim peshe" | — | |
| 2 | ai | "Po, kemi disa produkte për shtim peshe… - Mass gainer 3kg Qokolad… - Mega mass 3kg Qokolad…" | 25 | q=0.95, anchored |
| 3 | customer | "a keni tjera a veq qito" | — | |
| 4 | ai | "Po, kemi edhe disa produkte të tjera… - Critical Mass 6kg Keks - Pro Mass 1kg Qokolad" | 25 | q=0.92 |
| 5 | customer | "Cilen mkishe than ti me marr prej qitynve" (*which would you recommend?*) | — | no product keywords |
| 6 | ai | "Së shpejti do t'ju kontaktojë një specialist me informacion të saktë për produktin." | 10 | q=0.20, **hallucinated_product_name alert** |

The keyword-less turn-5 follow-up made retrieval return an unrelated top-10 (Melatonine, Creatine, C4… — EV-011 `catalogNames`). The name guard (`processAIReply.ts:2839-2868`) validated the draft recommendation against that per-turn retrieval set — not the catalog and not the conversation — and replaced with a holding message a recommendation naming **the same two products the AI itself listed at turn 2**, both real, active, in-stock, embedded catalog rows (EV-013, EV-015). Alert `ef3393c1` (EV-011). Same mechanism as DP-retrieval-14 / DP-gg-31 (03-divergence-analysis.md); guard grounding is S-36/S-42-scoped.

### Trace 2 — `18129839` (timeline `18129839-….json`): escalation cascade with anchor loss and flagged-content re-feed

| turn | sender | content (trim) | np | note |
|---|---|---|---|---|
| 1–6 | cust/ai | weight-gain products listed, "€55" price answer | 25→10 | clean sales phase |
| 7–12 | cust/ai | order flow: details requested, provided, confirm asked | **0** at t8 | anchor loss #1 (EV-019) |
| 13 | ai | "Porosia juaj është konfirmuar! Do të arrijë brenda 2-3 ditëve…" | **0** | q=0.200, **flagged=true** (the only flagged message in the DB, EV-018) |
| 14 | customer | "a keni ndonje produkt ne ofert be" (*any offers?*) — 17.5 min later | — | |
| 15 | ai | "Përshëndetje, do t'ju kthehemi së shpejti me një përgjigje." | **0** | `unclear` alert 19:15 + `uncertain_answer_escalated` alert 19:33 (EV-012, EV-014) |

This is the only conversation with two alerts (EV-014). Three anchor-loss events (turns 8, 13, 15 — EV-019). By turn 13, a raw-10 window has already excluded both the conversation opener and the turn-2 product answer (EV-021). The flagged turn-13 message sat *inside* the context window of the turn-15 reply — flagged content is re-fed verbatim, with no exclusion from history (EV-022; DP-pc-14, S-40). The turn-15 answer to the offers question was a generic hold-off; details JSONB shows `negative_availability_detected: true` on the original draft "Nuk kemi oferta aktive për momentin." (EV-012) — the drafted answer was suppressed into a promise of a follow-up that nothing in the system tracks.

### Trace 3 — `0a2b2999` (timeline `0a2b2999-….json`): denial-after-recommendation, two turns apart

| turn | sender | content (trim) | np | note |
|---|---|---|---|---|
| 1–2 | cust/ai | address question → answered | 0 | q=0.95 |
| 3 | customer | "A keni ndonje proteina te mira per shtim peshe" | — | |
| 4 | ai | "Po, kemi disa opsione… - Mass gainer 3kg Qokolad: …" | 0 | q=0.95, recommendation given |
| 5 | customer | "Sa kushtojn kto" (*how much do these cost*) | — | |
| 6 | ai | "Më vjen keq, por **produktet që përmenda nuk janë në katalogun tonë aktual**…" | 0 | q=0.200 |

The AI recommends catalog products at turn 4 and, two turns later, denies that those same products are in the catalog — Mass gainer 3kg Qokolad is an active €52.00 row (EV-013). Note `np=0` on turn 4: the recommendation itself persisted no anchor, so turn 6 had nothing to rehydrate and re-retrieval on "Sa kushtojn kto" (no keywords) missed. No alert fired — the contradiction is invisible to the alert system. Same shape in `29238c0d` t4→t6, `306e56fe` t2→t4, `f911e3dd` t13→t15, `79a58aac` t3→t7 (EV-018). Mechanism: DP-retrieval-12/13/14 (S-36) + the fact that the only cross-turn consistency guard checks *prices only* (`conversationFactConsistencyGuard.ts:15-17,26-28`).

### Trace 4 — `1d001d46` (timeline `1d001d46-….json`): 32-message conversation crossing the context window repeatedly

The longest conversation in the DB (19 customer / 13 AI turns, EV-017). Turns 1–5: Nitro Tech Ripped availability + photo request → `product_image_unavailable` alert at turn 5 (EV-023 — one of only two *early* alerts, and the only alert type after which conversations demonstrably continue). Turns 6–18: pivot to creatine, price comparison, full order placed and confirmed (t16, q=0.200, np=0 — anchor loss, EV-019). Turns 19–30: second product episode ("Hej a keni naj produkt tmir per shtim peshe…"), second order placed and confirmed (t30, np=0 — anchor loss). Turns 31–32: "Flm shum kalofshi mir" / "Qysh o moti sot" (*how's the weather today*) — **no reply at all**.

Window math (EV-021): 8 of the 13 AI replies were generated after the original product context (turn 3) had scrolled out of a raw-10 window; every AI turn from t14 onward also lost the conversation opener. The conversation *survives* the window loss because the customer restates intent at each episode boundary — the system's multi-turn coherence here is customer-subsidized, not state-managed.

### Trace 5 — `1f6a08de` (timeline `1f6a08de-….json`): mid-conversation escalation, resume, and an order confirmed with the hallucination-guard suite disabled

| turn | sender | content (trim) | note |
|---|---|---|---|
| 1–2 | cust/ai | "a keni produkt per shtim peshe" → "kemi produktin **Mass Gainer Pro**…" | np=0 |
| 3–5 | human/cust/ai | usage question → "Përdoret 1 herë në ditë…" | answered |
| 6–7 | cust/ai | "Un i kom 15 vjet, a muna me perdor…" → "Po, mund ta përdorni… nuk është i rekomanduar vetëm për moshën nën 12 vjeçare." | age/safety answered directly |
| 8–9 | cust/ai | pregnancy question → "së shpejti do t'ju kontaktojë një specialist…" | `usage_question_unanswered` alert `a44f3bbc` — one of only 4 *mid*-conversation alerts (EV-023) |
| 10–12 | cust/ai | 23 min later: "a muna me porosit nje mass gainer ne keto te dhena…" → "Porosia juaj për **Mass Gainer Pro** është konfirmuar…" | order confirmed with no detail-confirmation step |

"Mass Gainer Pro" is absent from EV-013's audit-time mass-gainer ILIKE sweep (which filters `deleted_at IS NULL`), but the products table shows it **was a real catalog row at conversation time**: created 2026-04-25, active and in-stock at €34.50, soft-deleted 2026-06-02 — three days *after* these 05-30 conversations. The same name was recommended in `12af2f76`, `7dd53b3e`, `b973ad04`, `ef6b1740` and confirmed as an order in `1f6a08de` t12, `ef6b1740` t4, and `d218dd90` t5 (EV-018). None of these turns had the name guard active: on all of them `np=0` — when the full-catalog fallback context is used, `matchedProducts` is emptied and **the entire hallucination-guard suite is silently disabled** (DP-gg-31, S-42) — so the names went out unvalidated and were correct only because the row happened to exist. Contrast with Trace 1, where a *correct* name was suppressed: whether the guard fires depends only on the retrieval state of the turn, not on the truth of the reply.

### Trace 6 — `cdd0bdea` (timeline `cdd0bdea-….json`): a clean conversation, for contrast

22 messages, 0 alerts, 0 flags (EV-017). Location → phone → opening hours → weight-gain products → "Sa kushton mega masa?" → correct €55.00 price (matches EV-013) → order details → confirmation → 12 min later a follow-up ("a muna me Porosit produktin e njejt veq me shije qokollad") answered correctly with the same product and flavor → delivery-time question answered ("brenda 24 orëve", consistent with the earlier confirmation). Every scored mid-conversation reply is 0.90–0.95; only the confirmation carries the systematic 0.200 (EV-018 note). This shows the pipeline *can* hold a 22-message thread — when retrieval keeps hitting and no guard misfires.

---

## Failure catalog with origin attribution

| # | Failure mode | Occurrences in dev data | Origin | Enabling code mechanism | Remediation direction (category only) |
|---|---|---|---|---|---|
| 1 | Correct answers suppressed as "hallucinations" → escalation | 3/3 hallucination alerts are false positives (EV-011, EV-013, EV-015) | Guards validate reply against the per-turn retrieval set, not the catalog or the conversation | `processAIReply.ts:2794-2809` (price), `:2839-2868` (name), alerts `:3251`/`:3295`; DP-retrieval-14, S-36/S-42 | guard-grounding redesign — specifics in Phase 16 |
| 2 | Product-anchor loss on order-flow/escalation turns | 10 events across 6 conversations (EV-019) | Holding/escalation and order-flow replies persist `product_ids=[]` by design; rehydration silently drops rows | `processAIReply.ts:3211` (DP-retrieval-12, merged DP-po-29); DP-retrieval-13/14, S-36 | state-management redesign — specifics in Phase 16 |
| 3 | Denial-after-recommendation (self-contradiction) | 8 conversations: 5 existence-denials (`0a2b2999`, `29238c0d`, `306e56fe`, `f911e3dd`, `79a58aac`), 3 price-capability denials (`f412d3f4`, `254a70cc`, `af548526`) (EV-018) | Per-turn re-retrieval with no cross-turn fact memory beyond a single-price check | `conversationFactConsistencyGuard.ts:26-28,54,75` (prices only, look-back 6, single-price replies only); DP-retrieval-01/03/23 | cross-turn consistency memory — specifics in Phase 16 |
| 4 | Product names sent and sold with the hallucination-guard suite disabled | "Mass Gainer Pro" in 6 conversations, 3 confirmed-order replies — a live catalog row at conversation time (05-30), soft-deleted 06-02 and hence invisible to EV-013's audit-time sweep; "Optimum Nutrition Gold Standard Whey" in `509f4690` — no exact catalog row, inexactly naming then-active "Gold standard whey" rows (EV-018, EV-025, EV-013) | Full-catalog-fallback empties `matchedProducts` → guard suite disabled exactly when retrieval failed | DP-gg-31 (S-42); contrast with #1 | guard-coverage redesign — specifics in Phase 16 |
| 5 | Conversation-terminating escalation cascade | 16/20 alerts at/within one message of conversation end; 14 late + 4 mid (EV-014, EV-023) | Canned "specialist will contact you" fallback + pause, with fail-closed gap assessor and no follow-up state | DP-gg-14 (S-48); `18129839` double alert (EV-014) | escalation-flow redesign — specifics in Phase 16 |
| 6 | Identical input → divergent outcome | 60/165 near-identical cross-conversation message pairs diverge (EV-025) | Retrieval timing coin-flip + stochastic classifier conjunctions | DP-retrieval-01/03/23, DP-po-30 (S-70); see Issue-1 section below | determinism hardening (Issue 1) — specifics in Phase 16 |
| 7 | Eval model mis-scores closing messages; flagged content re-fed | Every order confirmation scored 0.200; the single flagged message re-entered the next reply's window (EV-018, EV-022) | Quality eval penalizes confirmations; history builder does not filter flagged/undelivered replies | DP-pc-14 (S-40) | eval calibration + history filtering — specifics in Phase 16 |
| 8 | Context-window loss in long conversations | 15/92 AI turns in >10-msg conversations generated after the first product answer left the raw-10 window (EV-021) | Fixed positional windows (40 fetch / raw-10 / 6000-token budget), no summarization | `aiService.ts:92-98,108-112` | context summarization — specifics in Phase 16 |
| 9 | Corrupted (mojibake) fallback text sent to customers | 2 messages on 06-27 ("S� shpejti…"), clean UTF-8 on 06-23 (EV-011) | Encoding regression in the fallback-message path within that window | EV-011 note; conversations `3ea2ace9`, `cf2bf59a` | text-encoding fix — specifics in Phase 16 |
| 10 | Silent no-reply to inbound messages | 2 one-message `ai_paused` conversations (`0a4cde32`, `88283c5e`, EV-017); unanswered final customer messages in `1d001d46` t31-32, `2b375480` t16, `12af2f76` t15 (EV-018, EV-023 `fires_at > total`) | Pause states and persist-without-enqueue races leave inbound messages with no reply and no artifact | DP-iq-15 (S-13); EV-017 | silence detection/alerting — specifics in Phase 16 |

**Cross-cutting observation:** modes 1–4 are one mechanism seen from four angles — conversation-level truth (what the AI already said) is never a validation input; only the current turn's retrieval set is. This is the same central mechanism identified in 03-divergence-analysis.md (S-36 anchor chain, DP-retrieval-12/13/14, DP-gg-31).

---

## Conversation state management adequacy

**What exists** (observations only):

- **Per-message product anchor:** `messages.product_ids` JSONB persisted on every outbound AI message (`processAIReply.ts:3211`; schema EV-016). Rehydrated via `findActiveProductsByIds` on later turns (DP-retrieval-13). It is the only persisted link between a reply and the products it discussed.
- **Conversation-level flags:** `ai_paused`, `human_replied` (sticky), `human_override_until`, `fully_ai_handled`, `status` (EV-016). These gate *whether* the AI replies, not *what it knows*.
- **Reply threading fields:** `reply_to_message_id` / `reply_to_content` and `edit_history` on messages (EV-016) — present but not consumed as conversational memory.
- **One narrow cross-turn fact guard:** `conversationFactConsistencyGuard.ts` — prices only, look-back 6 AI turns, and only when both the current and the prior reply state *exactly one* price (`:26-28,54,75`). By design it cannot see the multi-price list replies that dominate the dev data (e.g. `1d001d46` t9, `6a120665` t17).

**What does not exist:**

- **No summarization store** — nothing persists "customer wants weight-gain product, was quoted €55 for Mega Mass" when the raw window scrolls (EV-021).
- **No fact memory** — established facts (product under discussion, quoted price, stated flavor) live only in raw message text; once outside the window they are gone, and inside the window they compete with 26–33K chars of system prompt (findings-seed, prompt section).
- **No correction tracking** — a customer or guard correcting the AI leaves no state; flagged replies are re-fed verbatim (EV-022, DP-pc-14).
- **No escalation follow-up state** — "a specialist will contact you" creates an `ai_alerts` row with status unread/read/resolved (EV-008) but no linkage back into the conversation; 16/20 escalations simply end the thread (EV-014).
- **No prompt/window logging** — what the model actually saw per reply is unrecoverable (see Method), which is why this audit had to reconstruct windows positionally.

**Adequacy assessment (observation):** the anchor design is inverted relative to need — `product_ids` is emptied precisely on the turns where state matters most (order close, escalation — EV-019 note), and the only fact guard covers the one attribute (a single price) least represented in real reply shapes. The clean trace (`cdd0bdea`) succeeds because the customer restates context, not because the system retains it.

---

## Degradation thresholds

**Q4 — quality vs. depth (EV-020).** Mean `quality_score` by AI-turn bucket: 1-3 → **0.839** (n=88 scored), 4-6 → **0.793** (n=35), 7-10 → **0.719** (n=14), 11+ → **0.700** (n=3). The decline is monotonic, but confounded: deep buckets contain proportionally more order confirmations, which the eval model systematically scores 0.200 (EV-018 note). With n=3 in the 11+ bucket, no turn-depth threshold can be responsibly stated from dev data.

**Q5 — window crossings (EV-021).** In every >10-message conversation, the first customer message is turn 1, so every AI turn past turn 11 has positionally lost the conversation opener under a raw-10 window; 15 of 92 AI turns in those conversations were generated after the first product-anchored answer had scrolled out. `1d001d46` shows the practical consequence bound: 8/13 replies past the original product context, and the two trailing customer messages received no reply.

**Q7 — alert clustering (EV-023).** 14 late / 4 mid / 2 early. Alerts do not cluster late because deep turns degrade — they cluster late because **escalations end conversations** (EV-014: 16/20 terminal). The causality runs alert → conversation end, not depth → alert. The only alert type conversations survive is `product_image_unavailable` (both early; `1d001d46` went on to place two orders).

**Verdict on thresholds:** the dev corpus (44 conversations, one tenant, max depth 32 messages, 3 AI turns past index 10) is too small and too test-shaped to establish degradation thresholds. What *would* be measurable in production: (a) quality-vs-depth with confirmation-type replies excluded from the eval average; (b) per-turn alert hazard rate conditioned on anchor presence (`np>0` vs `np=0` on the preceding AI turn); (c) contradiction rate (mode 3) as a function of turns-since-last-anchored-reply; (d) frequency of window crossings at the true 40-message/6000-token boundaries rather than the raw-10 proxy.

---

## Issue-1 corroboration from Q9

EV-025 (pg_trgm similarity > 0.75 over same-tenant customer messages across different conversations): **165 near-identical pairs, 60 with different outcomes** — the same utterance is a coin-flip between a confident answer, a wrong-product answer, a canned escalation, and silence.

- **Cleanest pair:** "Sa her ne dite muna me perdor?" (sim 1.00) — answered factually in `12af2f76` (05-30 21:05) and `1f6a08de` (22:03), escalated with `usage_question_unanswered` alerts in `b973ad04` (21:46) and `7dd53b3e` (21:54). The failures are *interleaved between* the two successes on the same evening, ruling out a config change as the sole cause (EV-025 note). Consistent with the per-worker retrieval timing coin-flip (DP-retrieval-01/03/23) and stochastic classifier conjunctions (DP-po-30, S-70) documented in 03-divergence-analysis.md.
- "Pershendetje a keni carbo one" (sim 1.00): human "Po." in 3 conversations; AI "Po." then false-positive `hallucinated_price` escalation in `3ea2ace9`/`cf2bf59a`; AI answering about the wrong product (L-carnitine) + alert in `28bec994` (EV-025, EV-011).
- "a keni … produkt … per shtim peshe" openers: four *different* recommendation sets across conversations, including "Mass Gainer Pro" — a row live on 05-30 but soft-deleted 06-02 and thus absent from EV-013's audit-time sweep (EV-025 note) — retrieval nondeterminism visible end-to-end.
- "Sa kushtojn kto?" produced correct prices, "no access to prices", and "those products aren't in our catalog" in three conversations — and in `f412d3f4` both a failure (t4) and a success (t8) *within the same conversation* for the same wording (EV-025, EV-018).

This independently corroborates Issue 1 (identical input → divergent behavior) from data alone, without reference to the code paths that Phase 3 identified as its cause.

---
*Phase 4 authored 2026-07-11. Evidence citations: EV-011 – EV-025 (appendix-A-evidence-log.md); timeline JSONs in session scratchpad `audit/timelines/`; DP/S ids per 03-divergence-analysis.md.*
