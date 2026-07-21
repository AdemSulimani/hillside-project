# Attribute-Mislabel Fix — Validation Evidence

**Date:** 2026-07-21 · **Branch:** `fix/alert-noise-pause-policy`

## Symptom
Customer asked a product's **price + flavor** (flavor column left NULL on purpose). The AI
answered price correctly but appended *"We will notify you shortly regarding the **brand**."*
— naming an attribute the customer never asked about instead of flavor.

## Root cause
The missing-attribute label in the "we'll notify you…" notice can come from the gap-assessor
**LLM's free-form `missing[]`** (`productInformationGapService.ts`), which the model writes
itself (prompt examples are literally `["brand"]`/`["marka"]`). The guard that strips such
structured labels — `filterFreeFormInfoLabels` — existed and was unit-tested, but only ran
behind `GAP_GATE_DETERMINISTIC_FIRST` / `GROUNDING_GATE_CONSOLIDATED`, **both default-off**, so
production passed the raw label through (`processAIReply.ts:3942` legacy arm). For the test
product "Carbo one 1kg Limon" the name contains "Limon", so name-inference marks flavor
answerable → the deterministic net emits nothing → the spurious LLM structured label was the
only one left.

## Fix (code-only; no flag flipped)
1. `filterFreeFormInfoLabels` now runs **unconditionally** — structured labels come solely
   from the deterministic, requested-scoped net; the LLM may only add allowlisted free-form
   gaps. Escalation *decision* (`decideGapEscalation`, still flag-gated) unchanged.
2. The `detectRequestedAttributes` all-keys category-follow-up expansion is opt-out
   (`expandCategoryFollowUp:false`) in the gap block, so a bare browse question no longer
   flags every NULL column as missing.
3. Inflection-aware recall in `detectRequestedAttributes` ("shijen", "markën", "flavors",
   "ngjyrash"…) so a genuinely-requested attribute is reliably detected.

## Offline gates (all green)
- `npm run typecheck` — clean
- `npm test` — **2257 pass / 0 fail** (474 suites), incl. new `partialAnswerLabelSanitation.test.ts`
  and extended `productRetrieval.test.ts`
- `npm run eval:golden` — RC-01 digest `ac176742…aeea98`, **deterministic across 3 runs**;
  answerable cases 0/20 escalations, genuine GAP cases 20/20
- `npm run config:check` — OK, no violations (no knob changes)

## Live reproduction (real OpenAI classifier + real DB rows, in-process through the exact gap-block merge)
Tenant `02beb134-…`. `OLD` = raw passthrough (pre-fix production), `NEW` = filtered (post-fix).

| # | Scenario | LLM `missing` (raw) | Deterministic missing | OLD merge | NEW merge → reply | Names brand? |
|---|----------|--------------------|----------------------|-----------|-------------------|-------------|
| 1 | Carbo one 1kg Limon, price+flavor (SQ) | `["shije"]` | `[]` (flavor="Limon" from name) | `["shije"]` | `[]` → grounded reply sent as-is | **no** |
| 2 | Iso Protein Pro, price+flavor (EN, genuinely missing) | `["flavor"]` | `["flavor"]` | `["flavor"]` | `["flavor"]` → "…€49.99. We will notify you shortly regarding the flavor information." | **no** |
| 3 | Iso Protein Pro, pure price (SQ) | `[]` | `[]` | `[]` | `[]` → no escalation | **no** |
| 4 | Iso Protein Pro, calories (SQ) | `["kalori"]` | `[]` | `["kalori"]` | `[]` → no escalation | **no** |

Notes:
- The live model emits a **structured** attribute label freely and non-deterministically
  (here "shije"; the original report and the RC-01 replay saw "brand"/"marka"). The fix drops
  every structured synonym regardless of which one the model picks, so it is robust to the
  stochasticity — that is the whole point of owning structured labels deterministically.
- **Scenario 1** now returns the correct grounded reply (flavor *is* derivable from the name
  "Limon"), rather than a spurious notice. Blank-column attributes whose value is stated in the
  product name are intentionally treated as answerable (`NAME_ATTRIBUTE_PATTERNS`, preserved).
- **Scenario 4** shows the pre-existing free-form allowlist behavior, now applied on the
  default path: the model shortened the label to the bare word "kalori", which is deliberately
  **not** in `FREE_FORM_INFO_STEMS` (bare nutrition words are the RC-01 false-escalation
  drivers in a supplements catalog), so it fails soft. The multi-word forms ("sa kalori ka",
  "calorie content") still escalate. Net effect is fewer false escalations — no wrong attribute
  is ever named.
