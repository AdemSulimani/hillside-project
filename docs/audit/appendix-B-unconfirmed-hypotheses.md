# Appendix B — Unconfirmed & Refuted Hypotheses

> **Evidence base:** All findings below are grounded in source code (file:line cited) and, where noted, the dev/staging database (6 tenants / 46 conversations / 374 messages / 617 products / 20 ai_alerts) and live-replay experiments (Phase 10, small-N). Dev data demonstrates mechanisms, not production incidence rates. See appendix-A-evidence-log.md for verbatim query evidence.

This appendix records root-cause candidates that were **refuted** — or so heavily narrowed on their distinctive claim that they do not stand as independent root causes — during Phase 11 arbitration. Nothing is silently dropped: each entry states the original claim, the refutation reasoning (with source), where the valid residual (if any) is captured in the main ledger, and what new evidence would revive it.

The arbiter re-verified the disputed source directly (the blind-verifier verdict payload was not delivered — see the arbiter note in `11-root-causes.md`).

---

## RC-12 — "Name/price hallucination guards REPLACE previously-correct product facts with items from a shifted/rotated retrieval window" — **REFUTED (distinctive mechanism)**

- **Issue:** 2 (nominated the "strongest Issue-2 case")
- **Original severity:** High
- **Original claim:** On a keyword-less follow-up turn, retrieval rotates `matchedProducts` to ~10 unrelated items (not empty), and `filterHallucinatedProductNames` then finds the AI's correct, previously-recommended, in-stock product names absent from the current window and **REPLACES them with items from the rotated window** — so the conversation degrades to **recommending different/wrong products** later. The candidate asserted the guard "returns early only when `matchedProducts` is EMPTY; when it is merely shifted the *replacement path* runs," and that the customer "gets a wrong product for a question the AI had answered right two turns earlier."

### Refutation reasoning (source-verified)

The distinctive substitution mechanism does not exist in the code.

1. **`filterHallucinatedProductNames` (`backend/src/services/aiService.ts:3381-3446`) is a pure detector.** It returns `{ hasHallucination, suspectedNames }` and nothing else — it contains no product-substitution logic and never reads a "rotated window" to pick a replacement product. It compares reply names to `matchedProducts` via a *fuzzy, conservative* LLM validator (its own prompt: "Carbo One" matches "Carbo One 1kg me shije limon"; "Only flag when you are confident the name does not match any listed catalog product").

2. **It fails OPEN, not closed** (`:3441-3445`, `catch → console.warn('...failing open') → return empty`) — the opposite of the candidate's implied fail-behaviour.

3. **The call site does not substitute a product — it replaces the ENTIRE reply with a canned holding message and escalates** (`backend/src/jobs/processAIReply.ts:2857-2872`):
   ```
   if (nameGuardResult.hasHallucination) {
     ...
     productNameHallucinationEscalated = true;
     finalReplyText = HOLDING_MESSAGES[replyLocale].productKnowledgeEscalation;  // whole reply → holding msg
     ...
   }
   ```
   There is no path that swaps a "window item" into the reply. The customer never receives "a wrong product"; they receive a generic holding/escalation message, and the turn is escalated + (downstream) paused.

Because the candidate's differentiator ("replaces with a different/wrong product from the rotated window") is false, RC-12 does not stand as an independent root cause.

### Valid residual (already captured in the main ledger — not lost)

RC-12's underlying, *correct* kernel is real: because the guard judges the reply against **this turn's retrieval window** rather than the catalog, a correct reply naming a real, active, previously-recommended product that is not in the current window is escalated. That mechanism is **fully captured by RC-02** (guards validate against the per-turn retrieval set, not the catalog — including the arbiter's correction that the name-guard escalates to a holding message), and its "correct-early → silent-later" consequence is **captured by RC-14** (escalations fire at the final turn; no AI auto-resume). No evidence is discarded — it is attributed to the two confirmed causes that actually own it. The dev conversation cited (fcd0af7e) is evidence for the RC-02 + RC-14 chain (correct reply → guard escalation → holding message → terminal silence), not for a product-substitution mechanism.

### What would revive RC-12 as an independent cause

Concrete source or runtime showing an actual **substitution path** — i.e. code that, on `hasHallucination`, rewrites the reply to name a *different specific product drawn from the current retrieval window* (rather than the observed whole-reply-to-holding-message replacement), **or** a dev/production transcript in which the customer demonstrably received a *wrong specific product recommendation* (not a holding/escalation message) that is traceable to the guard rather than to the model's own generation (RC-03). Absent one of those, the phenomenon remains RC-02 + RC-14, not RC-12.

---

## Note on the three WEAKENED candidates (retained in the main ledger)

For completeness: three candidates were **narrowed** but **kept** in `11-root-causes.md` rather than refuted — they are listed here only as a pointer, with their full narrowed claims in the main ledger.

- **RC-04** (semantic-retrieval 5s race): mechanism code-confirmed and retained; the **Issue-1 magnitude** was narrowed because EV-043 shows the vector arm rarely clears the 0.65 threshold with `text-embedding-3-small`, so dropping the semantic source frequently changes little. Strongest as a reliability / Issue-2 degradation vector.
- **RC-09** (unscoped channel resolution): code-confirmed isolation defect retained, but **dormant** — the dev `channels` table has 0 rows and no dual-connected account is known to exist, so the runtime "identical webhook → different tenant" divergence is latent/hypothetical, not observed.
- **RC-15** (depth quality decline + eval false-low + threshold 0.1): the **threshold drift (live 0.1 vs example 0.6)** and the **systematic 0.200 eval on order confirmations** are confirmed; the **depth→quality causal decline (0.839→0.700)** was narrowed to correlational (may reflect conversation-type mix — harder questions arriving later — rather than proven degradation).

These would be *fully* re-confirmed by, respectively: (RC-04) production evidence that embedding timeouts materially change `matchedProducts` at the current model/threshold; (RC-09) evidence that a single external account is connected under two tenants; (RC-15) a controlled study holding conversation type constant that still shows the depth decline.
