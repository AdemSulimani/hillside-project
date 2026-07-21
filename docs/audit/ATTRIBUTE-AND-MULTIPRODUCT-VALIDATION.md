# Audit & Live Validation — Attribute-Mislabel Fix (A) + Multi-Product Orders (B)

**Date:** 2026-07-21 · **Branch:** `fix/alert-noise-pause-policy` (uncommitted working tree)
**Method:** static audit (3 exploration passes + direct verification) → offline gates → live
end-to-end validation against the local dev stack (real OpenAI, real Postgres/Redis, signed
Messenger webhooks on the LIVETEST channel) → fix-and-reverify → this report.
**Honesty contract:** every PASS below is backed by an observed run (reply text, SQL row, log
line). Anything not fully verified is labeled as such.

---

## 1. Verdict summary

| Workstream | Static audit | Live validation | Production-ready? |
|---|---|---|---|
| **A — attribute mislabel** | CORRECT, with one INCOMPLETE edge found & fixed (F4 "marke" recall) | **PASS** — A1–A4 all green under the production (legacy-arm) flag posture; C2 re-run green under the shadow stack | **YES** (code-only fix, no flag needed) |
| **B — multi-product orders** | CORRECT, with one INCORRECT doc claim found & fixed (F1 cached-verdict crash) + commission-desync gap fixed (F2) | **PASS** — B0 (bug repro flag-off), B1 (2 lines + Σ commission), B3 (OOS skip), B4 (edit recompute), B5/F1 (second order from stale verdict) | **YES behind `MULTI_PRODUCT_ORDERS=true`** (validated) |

Flag postures validated live:
- **Config 0** (= production parity, all workstream flags off): B0 bug reproduction.
- **Config 1**: `MULTI_PRODUCT_ORDERS=true` + `GAP_GATE_DETERMINISTIC_FIRST=false` +
  `GROUNDING_GATE_CONSOLIDATED=false` + `FACTS_USED_CONTRACT=false` +
  `GROUNDING_GATE_ATTRIBUTE_FACTS=off` (fingerprint `b61f10d588b24110`) — the legacy escalation
  arm, i.e. the exact arm where the original mislabel bug lived.
- **Config 2**: `MULTI_PRODUCT_ORDERS=true` + full attribute-facts shadow stack
  (`GROUNDING_GATE_ATTRIBUTE_FACTS=shadow`, `GROUNDING_GATE_CONSOLIDATED=true`,
  `FACTS_USED_CONTRACT=true`, `AI_DECISION_LEDGER_ENABLED=true`) — see §6.

> **Prompt-vs-reality drift (important):** `GROUNDING_GATE_ATTRIBUTE_FACTS` is NOT part of the
> mislabel fix. It is the P3-1 declared-attribute grounding lane (contradiction-only), read at
> `processAIReply.ts:746`, used at `:4537`/`:4561`, and inert unless
> `GROUNDING_GATE_CONSOLIDATED=true` AND `FACTS_USED_CONTRACT=true`. Workstream A's fix is
> flag-independent (unconditional code). Also: `validateEnv.ts:229–235` only **warns** — it does
> not enforce — when `shadow` runs without `AI_DECISION_LEDGER_ENABLED`; the task brief's
> "validateEnv enforces this" is drift.

---

## 2. Baseline (Config 0, before any change)

All gates green, recorded 2026-07-21:

| Gate | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm test` | **2257 pass / 0 fail** (474 suites, 63.8s) |
| `npm run config:check` | OK — fingerprint `625a735dba77ad02`, 126 frozen knobs |
| `npm run eval:golden` | digest `ac176742…aeea98` — **identical to the digest recorded in ATTRIBUTE-MISLABEL-VALIDATION.md** |
| frontend `npm run build` | clean (tsc -b && vite build) |
| Migration 088 | applied; backfill intact: 27 orders → 27 order_items, 0 orders without items, 0 tenant mismatches |
| LIVETEST channel | exists (recreated again since the last campaign): `e695fb98-5019-447b-9ed4-258ec7d75480`, facebook, external_id `100000000000001`, ai_enabled |
| Test products | `e7160880…` "Carbo one 1kg Limon" intact (price 18.00, all structured cols NULL except category, name contains "Limon"); `1ce9c152…` "Iso Protein Pro" (49.99, flavor genuinely missing — 524-char extracted_text with no flavor cue) |

**Environment finding:** the dev `.env` was NOT at production defaults — it was left in the
P0-P3 campaign posture (deterministic-first arm + shadow stack + `CLASSIFIER_VERDICT_PERSISTENCE=true`).
Config 1 therefore had to *explicitly* set the legacy-arm flags to validate A on the arm where
the bug lived. `CLASSIFIER_VERDICT_PERSISTENCE=true` in dev also makes the F1 crash below a
live dev risk, not a theoretical one.

---

## 3. The two acceptance tests (headline results)

### 3.1 Workstream A — "names FLAVOR, not brand" (Config 1, legacy arm)

Live conversation `383e5070…` (sender …093), single turn, real OpenAI + real gap-block merge:

> **Customer:** "How much is Iso Protein Pro and what flavors does it come in?"
> **AI:** "The Iso Protein Pro costs €49.99. **We will notify you shortly regarding the flavor
> information.**" — conversation paused, `product_question_unanswered` alert.

Price answered; the notice names **flavor** — the attribute actually asked about — never brand.
And on the original reproduction product (conv `cc2f6df3…`, sender …092):

> **Customer:** "Sa kushton Carbo one 1kg Limon dhe cfare shije ka?"
> **AI:** "€18. Shije limoni." — grounded reply, no notice, no escalation.

This is the RCA's documented correct outcome: flavor is inferable from the name "Limon"
(`NAME_ATTRIBUTE_PATTERNS`), so no spurious notice is sent at all.

### 3.2 Workstream B — two products, both registered, commission on the sum (Config 1)

Live conversation `aa5b47e3…` (sender …095): price question → two-product order with details →
recap → "Po, konfirmoj". Draft order `92d6815b…` created by the pipeline:

| Field | Value | Check |
|---|---|---|
| `order_items` | **2 rows**: Iso Protein Pro ×1 @49.99 (idx 0); BSN Creatine 216gr ×1 @25.00 (idx 1) | ✓ both products |
| header `product_name`/`unit_price` | Iso Protein Pro / 49.99 | ✓ primary = highest line total |
| header `quantity` | 2 | ✓ Σ lines |
| header `total_price` | 74.99 | ✓ Σ lines |
| `commission_amount` | **3.75** | ✓ = round2(74.99 × 0.05) — **5% of the SUMMED total** |
| `is_commissionable` | true | ✓ no human in window |

Both per-item resolutions logged (`[ORDER_PRODUCT_RESOLUTION]` × 2, both `reason: unique`).
Contrast with **B0** (§4.1) where the identical conversation with the flag off registered ONE
line and 2.50 commission — the reported bug, reproduced live before flipping the flag.

---

## 4. Live validation — full scenario table

### 4.1 Config 0 — B0: original-bug reproduction (flag OFF)

Conversation `44e5c9a3…` (sender …081), fingerprint `625a735dba77ad02`, `MULTI_PRODUCT_ORDERS`
absent (default off). Customer ordered "nje Iso Protein Pro dhe nje BSN Creatine 216gr", AI
confirmed the order ("Faleminderit për porosinë! … do të mbërrijë brenda 24 orëve"), and the
draft order `7cdad281…` contains:

- 1 line only (Iso Protein Pro ×1, 49.99), header total 49.99, **commission 2.50 = 5% of one
  product**. The BSN Creatine (25.00) was silently lost — intent scalar `product_name: "Iso
  Protein Pro" quantity: 1` (the first loss point named by the B doc, observed directly in
  `[INTENT DETECTION]`).

This also proves the flag-off path is behaviorally the legacy single-product path with the new
code in place (F1's normalization included).

### 4.2 Config 1 scenarios

| # | Scenario | Result | Evidence |
|---|---|---|---|
| A1 | Carbo one 1kg Limon, price+flavor (SQ) | **PASS** — "€18. Shije limoni.", no notice, no pause | conv `cc2f6df3…` |
| A2 | Iso Protein Pro, price+flavor (EN), flavor genuinely missing | **PASS** — names **flavor** only; paused (partial) | conv `383e5070…` |
| A3 | Iso Protein Pro, price + "cfare shije dhe **cfare marke** eshte?" (multi-missing, indefinite Albanian) | **PASS** — "…kushton €49.99. Do t'ju njoftojmë së shpejti lidhur me **marka dhe shija**." Both requested attrs named (brand is *correct* here — it was asked); nothing unrequested. Live proof of fix F4 — the pre-fix regex missed "marke" and would have silently dropped brand | conv `125a512c…` |
| A4 | Browse follow-up "Cfare opsionesh keni?" after product context | **PASS** — options list; no structured attribute flagged, no notice, no escalation | conv `faee6344…` |
| B1 | Two-product order → draft | **PASS** — §3.2 | order `92d6815b…` |
| B2 | Same product twice in one basket → merged line | **NOT RUN LIVE** — deliberately. The live trigger (the intent classifier emitting two entries for the same product) is model-dependent and unreliable to provoke; the merge itself is deterministic and pinned by `orderLineAssembly.test.ts` ("same-product merge, summed qty"). Stated plainly: unit evidence only | `orderLineAssembly.test.ts` |
| B3 | Basket with an out-of-stock item (Creatine Gold Edition 250gr temporarily `in_stock=false`) | **PASS** — both items resolved, OOS line skipped with explicit log, order registered with only the in-stock line; commission on the registered line only. Full detail §4.3 | conv `edffbd7b…`, order `f6d54818…` |
| B4 | Merchant quantity edit on the multi-line draft | **PASS** — primary line 1→3 (149.97), line B untouched; header recomputed qty 4 / total 174.97; **commission recomputed 3.75 → 8.75** (fix F2 live-verified). Model-layer call (`updateDraftOrderForTenant`), same function the PUT route wraps; API auth layer not exercised | order `92d6815b…` before/after dump |
| B5 | "Also add X" after an order exists | **PASS** — new SECOND order `3eac5187…` (1 line, 32.00, commission 1.60), not an append — the owner-confirmed product decision | conv `aa5b47e3…` |
| F1 probe | Stale pre-088 cached verdict (no `items` key) consumed by the tail with the flag ON | **PASS** — crafted Redis entry `ai_clf:aa5b47e3…:livetest_f1probe…:purchase_intent` (verbatim pre-088 IntentResult shape) was consumed (probe marker visible in `[INTENT DETECTION] reasoning`), tail resolved and created the order via scalar-synth degradation, **no crash, no order_detection_failed** | order `3eac5187…` (same row as B5) |

### 4.3 B3 result — **PASS** (out-of-stock line skipped, order not sunk)

Conversation `edffbd7b…` (sender …099), "Creatine Gold Edition 250gr" temporarily set
`in_stock=false` (restored after). One turn ordering it together with Iso Protein Pro + full
details tripped `explicitNewOrder: true` and the tail:
- resolved **both** items (`[ORDER_PRODUCT_RESOLUTION]` ×2, both `reason: unique`);
- logged the skip verbatim: `[ai.reply] Skipping order line: product is out of stock
  { productName: 'Creatine Gold Edition 250gr' }`;
- created order `f6d54818…` with ONLY the in-stock line: Iso Protein Pro ×1, total 49.99,
  commission 2.50 = 5% of the registered line — the OOS line contributed nothing.

The customer-facing turn-1 reply was the legitimate OOS canned message (correct information,
delivered — quality eval skipped as `out_of_stock_canned_reply`). Turn 2's reply was a
**nameless** false denial ("produktet që kërkuat nuk janë në dispozicion" — no product named),
which the clause-scoped denial matcher cannot catch by design (nothing to match); see F5
residual in §5.

---

## 5. Defects found & fixed (fix-and-reverify), ordered by severity

Every fix: implemented → unit/source-pinned → `npm run typecheck` clean → full `npm test`
green → live re-verified where applicable. Suite progression: 2257 → **2264** (F1/F2/F4 pins)
→ **2266** (F5 pins), all 0 fail.

### F1 — HIGH (workstream B): cached pre-deploy verdict crashes the flag-on order tail
- **Where:** `classifierVerdictStore.ts:71` returns a cached hit as `JSON.parse` verbatim — it
  never re-runs the mapper — while `processAIReply.ts` (order tail) read `intent.items.length`
  unguarded. A purchase-intent verdict cached before the items[] deploy (6h TTL,
  `CLASSIFIER_VERDICT_PERSISTENCE=true` — which dev *currently has on*) has no `items` key →
  TypeError → swallowed into `order_detection_failed` → **order silently not created**.
- **Doc drift:** MULTI-PRODUCT-ORDERS-VALIDATION.md claims the backward-compat bridge "covers
  cached pre-deploy verdicts" — that was TRUE only for the compute path, FALSE for the
  cache-read path.
- **Fix:** the tail now re-normalizes every purchase-intent verdict through the pure
  `mapIntentPayload` (idempotent on already-mapped results; a stale blob degrades to the
  scalar-synth single line). `processAIReply.ts` order tail, verdict read site.
- **Verified:** idempotence + stale-blob unit tests (`intentMultiItem.test.ts`), source pin
  (`orderHeaderMirror.test.ts`), and the **live probe** in §4.2 (crafted stale Redis verdict →
  order created, no crash).

### F2 — MEDIUM (billing): commission desync after a draft quantity edit *(user-approved fix)*
- **Where:** `updateDraftOrderForTenant` recomputed qty/total via `recomputeOrderHeaderFromItems`
  (`order.ts:1011`) but `commission_amount` kept its creation-time value. Pre-existing for
  single-line orders; multi-line totals make the drift larger.
- **Fix:** `recomputeOrderHeaderFromItems` (the sole mirror writer — invariant preserved) now
  sets `commission_amount = ROUND(Σ total × 0.05, 2)` **only when `is_commissionable`**
  (`CASE WHEN o.is_commissionable … ELSE o.commission_amount END`). Only drafts are editable;
  billed/paid rows unreachable from this path.
- **Verified:** source pin (`orderHeaderMirror.test.ts`) + live B4 (3.75 → 8.75 observed in DB).

### F4 — MEDIUM (workstream A): "çfarë marke?" missed by the inflection recall
- **Where:** `productRetrievalService.ts` brand regex `mark(?:a(?:t|ve)?|en|es)` matched
  marka/markat/markave/marken/markes but NOT the bare indefinite **"marke"** — the most natural
  "what brand?" phrasing. Consequence: deterministic net misses the request, the sanitizer
  (correctly) strips the LLM's structured label → a genuinely-requested brand silently dropped
  from the notice (soft-fail understatement — the exact "slips the deterministic net" class the
  RCA's Fix 3 was meant to close).
- **Fix:** `mark(?:a(?:t|ve)?|e(?:n|s)?)` — adds bare "marke"; `\b` still rejects
  "market"/"marketing" (guardrail test kept green).
- **Verified:** unit probes + new `productRetrieval.test.ts` cases; live A3 (§4.2) shows
  "marka dhe shija" both named from "cfare shije dhe cfare marke eshte?".

### F5 — HIGH (adjacent, pre-existing — NOT introduced by A or B): false availability denial
ships raw on mid-order turns
- **Observed live, 3 times, deterministically** (convs `44e5c9a3` flag-off, `1da5bc96`,
  `aa5b47e3` flag-on): on a details-only or affirmation turn, retrieval runs on garbage text
  ("emri…, telefoni…, adresa…"), the ordered products are absent from the reply model's catalog
  context, and the model replies **"Iso Protein Pro dhe BSN Creatine 216gr nuk janë në
  dispozicion"** — both active, in-stock catalog rows — sometimes with alternatives attached.
- **Why every guard whiffed:** the false-denial backstop (2026-07-20 fix, commit 2fa8d84) keys
  on `inboundNamedProducts` — pinned from the **current** inbound only, which names no products
  on a details turn; the alternatives carve-out (`shouldEscalateUncertainAnswer`
  `uncertainAnswerFallbackGuard.ts:257`) then ships it as "guideline-compliant".
- **Fix (guard net):** when a denial-phrased reply arrives and the current inbound pinned
  nothing, the denial check now resolves product names from the **last 3 customer messages** —
  filtered to grams the reply itself mentions (a denial names what it denies) before hitting the
  bounded ladder. First attempt fed the whole recent text to the ladder and silently resolved
  nothing (junk name/address grams exhausted the 8-lookup budget — diagnosed by offline repro
  with the exact live texts); the reply-mention filter fixed it. Clause-scoping
  (`productsDeniedInReply`) is unchanged, so R13 "deny X, offer Y" replies still score only the
  denied clause.
- **Verified:** offline repro (`wouldEscalate: true`, denied `["BSN Creatine 216gr"]`), source
  pins (`replyPathSourceInvariants.test.ts`), and **live re-run of the exact failing flow**
  (conv `fb6aa25b…`): the details turn now ships the holding message, pauses, and raises
  `uncertain_answer_escalated` with `details.kind='false_availability_denial'`,
  `denied_product_names: ["BSN Creatine 216gr"]`.
- **Root cause NOT fixed here (stated plainly):** the reply model still *generates* the denial
  because mid-order turns lack the ordered products in retrieval context. The guard converts a
  shipped lie into a safe holding+pause. Root fix recommendation in §7. Two residual subclasses
  can still ship raw:
  1. a denial on a turn classified as an order-confirmation reply (`isOrderFlowReply`
     carve-out at `uncertainAnswerFallbackGuard.ts:243` precedes the denial rule at `:251`) —
     observed once (conv `aa5b47e3` turn 3, run before the F5 fix landed; the order itself was
     created correctly on that same turn);
  2. a **nameless** denial ("produktet që kërkuat nuk janë në dispozicion" — no product named,
     conv `edffbd7b` turn 2) — the clause-scoped matcher requires a product mention inside the
     denial clause, so it has nothing to match by design.
  The F5 net covers the named-denial details-turn class (the one observed most); both residual
  subclasses fall to the same root fix.

### F3 — LOW (workstream B, verified cosmetic — NOT fixed, by design of the check):
confirm/cancel/status API responses return `items: []`
- `findOrderByIdForTenant`/`updateOrderStatusForTenant`/`confirmOrderForTenant`
  (`order.ts:487–496, :543, :717`) do not attach items. Frontend impact verified NONE: both the
  drawer mutations and the socket handlers only `invalidateQueries` (no cache patch with the
  response body), so the UI refetches from readers that DO attach items. Left as an API-
  consistency recommendation (§7) rather than a defect fix.

---

## 6. Config 2 — shadow-stack + interaction run (all PASS)

Boot: clean, fingerprint `8f9a006706a41ce8`, posture line confirms
`GROUNDING_GATE_ATTRIBUTE_FACTS=shadow` + `GROUNDING_GATE_CONSOLIDATED=true` +
`FACTS_USED_CONTRACT=true` + `AI_DECISION_LEDGER_ENABLED=true` + `MULTI_PRODUCT_ORDERS=true`.
This arm flips `gapDeterministicFirst` to true — A's escalation-decision arm changes (expected,
that is the point of the second config).

| # | Scenario | Result |
|---|---|---|
| **C1** — ONE turn mixing a missing-attribute question AND a two-product order (conv `51849c7c…`) | **PASS — both invariants simultaneously.** Reply: "Iso Protein Pro is a high-purity isolate protein… **Do t'ju njoftojmë së shpejti lidhur me shija.**" — names only the requested flavor; conversation paused (partial gap). AND order `baffaae2…` created on the same escalated turn: 2 lines (Iso 49.99 + BSN 25.00), header qty 2 / total 74.99, **commission 3.75 = 5%×Σ**. The order tail correctly runs on a gap-escalated turn ("never sink a confirmed order"); the pause keeps a human in the loop for the flavor question. |
| **C2a** — Carbo one 1kg Limon price+flavor (SQ), deterministic-first arm (conv `07dd08ce…`) | **PASS** — "Carbo one 1kg Limon kushton €18.00 dhe ka shije limoni." Grounded, no notice, no escalation. |
| **C2b** — Iso Protein Pro price+flavor (EN), deterministic-first arm (conv `cb68dfd4…`) | **PASS** — "…costs €49.99. We will notify you shortly regarding the **flavor** information." Paused. Identical wording to the Config 1 run — the sanitation invariant holds on both escalation arms. |

**Ledger evidence** (`ai_decision_ledger`, all rows carry `config_fingerprint.hash =
8f9a006706a41ce8`):
- `grounding_attribute_lane` **shadow** row on C2a's grounded reply: branch
  `shadow:declared=1:contradicted=0:scopes=none`, passed=false — shadow verdicts are computed
  AND persisted; no enforce effects anywhere. (Escalated turns C1/C2b have no lane row — the
  gap escalation replaces the reply before the consolidated gate runs; consistent with design.)
- Bonus observation for P2-2's parity window: the `order_stage` shadow rows land as their own
  ledger rows (the P0-P3 Finding-3 fix working), including a genuine **divergence** on C1:
  `diverge:legacy=true:det=false:stage=collecting` — the legacy gate created the order, the FSM
  would not have (single-turn order with no prior recap). Relevant input for the
  `ORDER_STAGE_MACHINE=on` cutover decision; no action here.

---

## 7. Architecture assessment & recommendations (separate from defects)

### Assessment — Workstream B design
The **normalized `order_items` child table + maintained header mirror** is the right call for
this codebase and is well executed:
- It preserves every legacy single-product reader (27 pre-existing orders backfilled 1:1;
  header byte-identical for single-line orders — B0 observed) while making multi-line orders
  first-class. The alternative (JSONB lines on `orders`) would have broken the
  `product_id`-keyed queries and commission reporting; a view-based mirror would have required
  touching every reader. The chosen shape is additive and reversible pre-enable.
- `recomputeOrderHeaderFromItems` as the **sole mirror writer** is verified repo-wide (the only
  other writers of mirror columns are createOrder's INSERT and the recompute itself) and is the
  linchpin invariant — F2 extended it rather than adding a second writer, which is exactly how
  it should evolve.
- `createOrder` transactionality (single client, BEGIN/COMMIT/ROLLBACK, per-line inserts,
  header derived inside the model so callers cannot desync it) is correct; readers batch items
  via `= ANY($::uuid[])` — no N+1 (verified in all four list readers).
- The **intentPayload.ts / orderLineAssembly.ts split** is genuinely good: both are pure,
  openaiClient-free, and carry the entire multi-product semantics (coercion, merge, bucketing,
  pricing, rounding) — which is why 15+ unit tests could pin them without any mock ceremony.
  The tail keeps only orchestration.

### Assessment — Workstream A fix placement
`filterFreeFormInfoLabels` running unconditionally at the single `assessment.missing` read
site, with structured labels owned by the deterministic requested-scoped net, is the correct
architecture: the merge point (`processAIReply` gap block) is where both label sources meet, so
the sanitizer belongs exactly there. The two-set split (`requestedStructuredAttributes` for
gating vs `explicitRequestedAttributes` for missing-computation) is subtle but well-commented
and now pinned. No relocation recommended.

### Recommendations (no code changed for these)
1. **Root-fix the mid-order false denial (HIGH priority follow-up).** The reply model's catalog
   context should include the order-session products on details/affirmation turns — e.g. extend
   inbound-name pinning to a recent-customer-window when the conversation is mid-order-collection,
   or inject the order-slot product names into the prompt context. Until then the F5 net
   converts the lie into holding+pause on details turns, but the confirmation-turn class
   (`isOrderFlowReply` carve-out) remains exposed, and every occurrence stalls a paying customer.
2. **Attach items to confirm/cancel/status readers** (`order.ts:487/543/717`) for API
   consistency (F3) — trivial, removes the reliance on the frontend synth fallback.
3. **Bare-indefinite audit for the other attribute regexes.** F4 fixed brand; "madhesi" (bare),
   "ngjyre", "peshe" already match, but a systematic probe of all 7 regexes against the
   indefinite/ablative paradigm would close the class (the campaign probed brand, color, weight,
   flavor only).
4. **`extractCandidateNameGrams` cap ordering:** longest-first + cap-8 let junk grams crowd out
   product grams on multi-message text (found while fixing F5); if the ladder gains more
   callers with long inputs, filter for relevance before capping inside the helper.
5. **Localized notice declension:** "lidhur me marka dhe shija" is nominative; "lidhur me markën
   dhe shijen" would be correct Albanian. Cosmetic; the label table renders canonical forms.
6. **The order-collection recap dedupe** scans the last 8 messages for the recap lead-in — a
   long collection flow could re-send it. Not observed live; noted from reading.

### Static-audit observations (no action needed, recorded for accuracy)
- The gap-escalation transaction still force-writes `human_replied=false`
  (`processAIReply.ts:4059`) — as do ~10 other legacy escalation sites. The P2-audit S1 fix
  (commit 94c6b00, in this branch's history) removed it from the two *grounding* paths only.
  Pre-existing, untouched by workstream A (verified via `git diff` — no
  `setConversationHumanReplied` change in the working tree). Same billing-integrity argument
  applies; flagging for a future pass.
- The order tail runs even on gap-escalated turns — deliberate ("never sink a confirmed
  order"); the pause ensures human review.
- CLAUDE.md §7 lists "quantity" among order-info updates, but `detectOrderInfoUpdateIntent`
  extracts only address/phone/name/notes and `updateOrderCustomerInfoForAI` allows only those
  four keys — a customer "change quantity to 3" message does NOT edit the order (and never did).
  CLAUDE.md drift; merchant UI (`updateDraftOrderForTenam` → PUT route) is the only quantity
  writer, and it recomputes correctly (B4).
- Soft-deleted product mid-flow: `order_items.product_id` is `ON DELETE SET NULL`; lines keep
  name/prices, header mirror COALESCE-keeps name/unit_price, totals and commission are stored
  values — no recompute is triggered by product deletion, so billing is unaffected. Correct.
- Migration 088 backfill is re-run-safe (per-order `WHERE NOT EXISTS` guard); `.down.sql` is
  guarded and safe only pre-enable (as documented).
- `recomputeOrderHeaderFromItems` sets `product_id` un-COALESCE'd — on a zero-line order it
  would null the header product. Unreachable today (no path deletes all lines); noted.

---

## 8. Offline gates after all fixes (final tree)

| Gate | Result |
|---|---|
| `npm run typecheck` | clean (run after every fix) |
| `npm test` | **2266 pass / 0 fail** (baseline 2257 + 9 new tests: F1/F4 unit tests, F1/F2 source pins in `orderHeaderMirror.test.ts`, F5 pins in `replyPathSourceInvariants.test.ts`, F4 cases in `productRetrieval.test.ts`, idempotence/stale-blob cases in `intentMultiItem.test.ts`) |
| `npm run config:check` | OK — no violations (no knob manifest changes) |
| `npm run eval:golden` | digest `ac176742…aeea98` — **byte-identical to baseline**; the F4 regex change cannot drift RC-01 (corpora feed pre-resolved inputs) and provably didn't |
| frontend `npm run build` | clean at baseline; **no frontend file was changed by this campaign**, so the baseline build stands (stated, not re-run) |

Files changed by this campaign (all backend):
- `src/jobs/processAIReply.ts` — F1 (verdict re-map at the tail read), F5 (denial-check
  recent-customer fallback + reply-mention gram filter)
- `src/db/models/order.ts` — F2 (commission recompute in `recomputeOrderHeaderFromItems`)
- `src/services/productRetrievalService.ts` — F4 (brand regex + comment)
- Tests: `src/services/__tests__/orderHeaderMirror.test.ts` (new),
  `intentMultiItem.test.ts`, `productRetrieval.test.ts`, `replyPathSourceInvariants.test.ts`
  (extended)

Environment end-state: `backend/.env` restored **byte-identical** from the pre-campaign backup
(sha256-verified); dev server restarted and booting with the original fingerprint
`625a735dba77ad02`. The temporarily-OOS product (`Creatine Gold Edition 250gr`) restored to
`in_stock=true`. The crafted F1 Redis verdict key deleted.

---

## 9. Test-data inventory & OpenAI spend

**Dev-DB rows written (left in place as evidence; cleanup SQL below):**

| Sender (contacts.external_id) | Conversation | Purpose | Paused? | Orders |
|---|---|---|---|---|
| 9000000000000081 | `44e5c9a3…` | B0 flag-off repro | no | `7cdad281…` (1 line, the bug artifact) |
| 9000000000000082/83/87 | `08d157f0…`/`4b46327a…`/`1cba39c5…` | first wave — 429-contaminated (082/087 floor replies; 083 valid-but-wrong-arm) | 83 yes | – |
| 9000000000000092 | `cc2f6df3…` | A1 | no | – |
| 9000000000000093 | `383e5070…` | A2 | yes (partial gap) | – |
| 9000000000000094 | `1da5bc96…` | B1 attempt (derailed by pre-F5 denial; kept as F5 evidence) | no | – |
| 9000000000000095 | `aa5b47e3…` | B1 acceptance + B4 edit + B5/F1 probe | no | `92d6815b…` (2 lines, edited), `3eac5187…` (stale-verdict order) |
| 9000000000000096 | `fb6aa25b…` | F5 live re-verify | yes (false_availability_denial) | – |
| 9000000000000097 | `125a512c…` | A3 | yes (partial gap) | – |
| 9000000000000098 | `faee6344…` | A4 (2 429-floor turns + 2 valid) | no | – |
| 9000000000000099 | `edffbd7b…` | B3 OOS skip | no | `f6d54818…` (1 line) |
| 9000000000000101 | `51849c7c…` | C1 interaction | yes (partial gap) | `baffaae2…` (2 lines) |
| 9000000000000102 | `07dd08ce…` | C2a | no | – |
| 9000000000000103 | `cb68dfd4…` | C2b | yes (partial gap) | – |

Alerts written during the campaign window (tenant `02beb134…`, from 10:06 UTC):
`message_send_failed` ×22 (expected — fake LIVETEST page, every send fails, notify-only),
`product_question_unanswered` ×5 (the A/C partial-gap escalations — correct),
`provider_unavailable` ×5 (real OpenAI 429s → P2-6 floor, no pause — correct),
`uncertain_answer_escalated` ×1 (`false_availability_denial` — the F5 catch).

Cleanup (if/when desired — orders cascade order_items; conversations cascade messages/alerts):
```sql
DELETE FROM conversations WHERE contact_id IN (
  SELECT id FROM contacts WHERE tenant_id = '02beb134-a979-46bc-82b8-9d8f586190db'
  AND external_id IN ('9000000000000081','9000000000000082','9000000000000083','9000000000000087',
    '9000000000000092','9000000000000093','9000000000000094','9000000000000095','9000000000000096',
    '9000000000000097','9000000000000098','9000000000000099','9000000000000101','9000000000000102',
    '9000000000000103'));
DELETE FROM orders WHERE conversation_id IS NULL AND detected_by = 'ai' AND customer_phone LIKE '0441230%';
DELETE FROM contacts WHERE tenant_id = '02beb134-a979-46bc-82b8-9d8f586190db' AND external_id LIKE '90000000000001%';
DELETE FROM contacts WHERE tenant_id = '02beb134-a979-46bc-82b8-9d8f586190db' AND external_id IN
  ('9000000000000081','9000000000000082','9000000000000083','9000000000000087','9000000000000092',
   '9000000000000093','9000000000000094','9000000000000095','9000000000000096','9000000000000097',
   '9000000000000098','9000000000000099');
-- NOTE orders.conversation_id has no CASCADE from conversations in all schemas — verify FK
-- behavior before running; the draft orders can also simply be cancelled in the UI.
```
(Senders …061–079 from earlier campaigns were left untouched.)

**OpenAI spend:** ~29 pipeline turns (incl. 5 429-degraded ones that still consumed partial
fan-outs) at the measured ~$0.013–0.025 per generation plus the ~20-call classifier fan-out —
consistent with the P3-6 $0.0402/turn baseline — plus 3 offline probe calls.
**Estimated total: ≈ $1.20–1.60.** (Exact per-call records are in `ai_decision_ledger.usage`
and the `[ai.generation] usdCost` log lines for the campaign window.)
