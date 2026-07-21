# Root-Cause Analysis — AI Names the Wrong Missing Attribute

**Date:** 2026-07-21 · **Branch:** `fix/alert-noise-pause-policy`
**Severity:** customer-facing correctness (wrong information reported as unavailable)
**Status:** fixed (code-only, no feature flag flipped) · validation evidence in
[ATTRIBUTE-MISLABEL-VALIDATION.md](ATTRIBUTE-MISLABEL-VALIDATION.md)

---

## 1. The issue

A customer asked about a product's **price** and **flavor**. The `flavor` column had been
deliberately left NULL to test how the assistant handles a missing attribute. The AI:

- ✅ answered the **price** correctly, but
- ❌ for the missing flavor it replied *"We will notify you shortly regarding the **brand**."*

It named **brand** — an attribute the customer never asked about — instead of flavor. The
answer logic was otherwise correct; the defect was purely **which attribute got named** in
the "we'll notify you shortly" notice.

The reproduction product is **"Carbo one 1kg Limon"** (dev tenant `02beb134-…`, product
`e7160880-…`): every structured column is NULL except `category`, and the product **name**
contains "Limon".

---

## 2. How the pipeline is supposed to work

When a customer asks about a product's details, the reply pipeline
([`processAIReply.ts`](../../backend/src/jobs/processAIReply.ts)) runs a
**product-information-gap** step that decides one of three outcomes:

- `complete` — everything asked is known → send the AI reply as-is
- `partial` — some known, some missing → answer what we know **and** append a notice for the rest
- `none` — nothing answerable → send a holding notice

The customer-facing sentence is built **in code** by `buildMissingInfoNotice`
([`productInformationGapHelpers.ts`](../../backend/src/services/productInformationGapHelpers.ts))
— e.g. *"We will notify you shortly regarding the `<X>` information."* / *"Do t'ju njoftojmë
së shpejti lidhur me `<X>`."* The attribute name **X** comes from `finalMergedMissing`, which
the gap step assembles by **merging two independent label sources**:

```
                     customer message + matched product(s)
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        ▼                                                         ▼
 (A) LLM gap-assessor                                  (B) deterministic keyed net
 assessProductInformationRequest                       detectRequestedAttributes
   → free-form missing[] labels                          → computeMissingStructuredAttributes
   the MODEL writes the words itself                     → localizedAttributeLabels
   (prompt examples: ["brand"],["marka"])                keyed, scoped to REQUESTED attributes,
                                                          honors name-inference
        └───────────────────────────┬───────────────────────────┘
                                     ▼
                      dedupe → reconcile → finalMergedMissing → buildMissingInfoNotice
```

Source **(B)** is faithful: it is a set of direct keyed lookups, scoped to the attributes the
customer actually requested. Source **(A)** is a free-text list the model invents.

---

## 3. Root cause

**The customer-facing notice was allowed to name a structured attribute that came from the
LLM's free-text list, unconstrained to what the customer asked about.**

### 3.1 The unfiltered passthrough (primary)

A guard already exists to keep the LLM out of structured labeling —
`filterFreeFormInfoLabels` — which drops any label mapping to a structured-attribute synonym
(`brand`/`marka` is in `ATTRIBUTE_SYNONYM_GROUPS`) and keeps only allowlisted **free-form**
concepts (ingredients, usage, expiry…). But it was applied **only behind a flag**:

```ts
// processAIReply.ts (before the fix)
const llmMissingLabels = gapDeterministicFirst
  ? filterFreeFormInfoLabels(assessment.missing)   // strips structured synonyms
  : assessment.missing;                            // DEFAULT: raw model labels pass through
```

`gapDeterministicFirst = GAP_GATE_DETERMINISTIC_FIRST || GROUNDING_GATE_CONSOLIDATED`, and
**both flags default to `false`** ([`config/knobs.ts`](../../backend/src/config/knobs.ts)).
So in production the raw LLM labels went straight into the notice. The gap-assessor's system
prompt even primes the word — its examples are literally `["brand"], ["marka"]`
([`productInformationGapService.ts`](../../backend/src/services/productInformationGapService.ts)).

**This was a known, already-fixed-but-parked failure.** The regression test's own header
records the exact symptom:
> *"IN1 8/8 with missing=['marka'] though brand was never asked"*
> — [`gapGateDeterministicFirst.test.ts`](../../backend/src/services/__tests__/gapGateDeterministicFirst.test.ts)

The fix (`filterFreeFormInfoLabels` + deterministic-first) had been built and unit-pinned, but
only ran behind the default-off flag, so it never took effect on live traffic.

### 3.2 Why "brand" specifically, and why flavor wasn't named

For **"Carbo one 1kg Limon"**, the deterministic net treats flavor as **answerable from the
name**: `getProductInferredAttributes` / `NAME_ATTRIBUTE_PATTERNS`
([`productRetrievalService.ts`](../../backend/src/services/productRetrievalService.ts)) match
"Limon" and mark flavor available, so source **(B)** correctly emits nothing for flavor. That
left the LLM's spurious structured label as the *only* thing in the merged set — so the notice
named it alone. The reconciliation guards don't catch it because the (correct) price answer
never mentions the concept, so there is nothing to contradict.

Note the model's word is **non-deterministic**: the live reproduction emitted `["shije"]`; the
original report and the archived RC-01 replay saw `["brand"]`/`["marka"]`. The common failure
is *"the model freely names a structured attribute"*, not any one specific word.

### 3.3 Two adjacent latent defects on the same path

- **All-keys browse fallback.** `detectRequestedAttributes` returns **all 7 attribute keys**
  when no specific attribute word matched but the message looks like a category follow-up.
  Fed into the missing-attribute computation, that flags *every* NULL column (brand, color,
  variant) as missing on a mere "what options do you have?" — a purely deterministic route to
  naming unrequested attributes.
- **Inflection recall.** The requested-attribute regexes were anchored `\bshije\b` / `\bmarka\b`,
  which miss Albanian inflections ("shijen", "shijes", "markën", "ngjyrash"). A genuinely
  requested attribute could slip the deterministic net, pushing the naming decision onto the
  unreliable LLM label.

### 3.4 What was NOT the cause

No attribute mixing, transposition, off-by-one, parallel-array zip, or serialization defect.
Every label↔value pairing in the deterministic path is a direct keyed lookup (`table[key]`,
`attrs?.[key]`, `Set.has(key)`). The database rows were correct (genuinely NULL, not
mislabeled). The bug was trusting the LLM's free naming for a structured attribute.

---

## 4. The fixes

Decided approach: **decouple the label sanitation from the staged flag** — do *not* flip
`GAP_GATE_DETERMINISTIC_FIRST`/`GROUNDING_GATE_CONSOLIDATED` (they also change the escalation
*decision* to fail-open on assessor errors, are fingerprinted, and carry a deliberate
shadow-window rollout). The escalation **decision** is unchanged; only **which attribute is
named** changes.

**Invariant enforced:** the notice may name a *structured* attribute only if the customer
explicitly asked about it; structured labels come solely from the deterministic keyed net. The
LLM may still contribute genuine **free-form** gaps.

### Fix 1 — sanitation runs unconditionally (the core fix)
[`processAIReply.ts`](../../backend/src/jobs/processAIReply.ts)

```ts
// after: sanitation ALWAYS runs, independent of the escalation-policy flag
const llmMissingLabels = filterFreeFormInfoLabels(assessment.missing);
```

`gapDeterministicFirst` still governs the escalation **decision** (`decideGapEscalation`) and
the errored-assessor log, so *when* we escalate is unchanged. A spurious structured LLM label
is now always dropped; if nothing genuine remains, the request resolves to `complete`
(grounded reply sent as-is) or, on a fail-closed assessor, a **generic** notice — never a
wrong attribute name.

### Fix 2 — the browse fallback can't invent missing attributes
[`productRetrievalService.ts`](../../backend/src/services/productRetrievalService.ts) ·
[`processAIReply.ts`](../../backend/src/jobs/processAIReply.ts)

`detectRequestedAttributes` gained a non-breaking option `{ expandCategoryFollowUp }`
(default `true`, preserving aggregation and heuristics callers). The gap block computes an
`explicitRequestedAttributes` with `expandCategoryFollowUp:false` and feeds **that** to the
missing-attribute computation, the multi-product per-product pass, and the alert telemetry —
so a bare browse follow-up no longer enumerates every NULL column. The expanded set still
drives *when* the gap step runs, so behavior is unchanged for real attribute questions.

### Fix 3 — inflection-aware recall
[`productRetrievalService.ts`](../../backend/src/services/productRetrievalService.ts)

The requested-attribute regexes now allow bounded Albanian inflection suffixes (definite,
plural, case, and `-sh` indefinite-plural), e.g. `shije(?:t|n|sh|s|ve)?`,
`mark(?:a(?:t|ve)?|en|es)`, `ngjyr[aeë]?(?:t|n|sh|s|ve|ne)?`, `pesh[aeë](?:t|n|s|ve|ne)?`.
Suffixes are kept narrow so "shijshëm" (*tasty*) and "market"/"marketing" do **not** false-match.

### Out of scope (deferred)
- Neutralizing the assessor prompt's `["brand"]/["marka"]` example priming (defense-in-depth
  only; the deterministic Fix 1 is the real guarantee).
- Symmetric NULL rendering in `formatProductCatalog` (the `Brand: Unknown` placeholder only
  affects the main reply-model prompt, which is discarded when the gap step escalates, and
  touching it risks the `extractCatalogBrandProductPairs` re-parser).

---

## 5. Edge cases covered

| Case | Behavior after fix |
|------|--------------------|
| Price + flavor, flavor null but inferable from name (Carbo Limon) | Grounded reply (flavor from name); **no** wrong-attribute notice |
| Price + flavor, flavor genuinely absent (no name cue) | Notice names **flavor/shija**, never brand |
| Pure price question | No missing-info notice |
| Multiple requested attrs missing | Notice names each requested attr; no unrequested attr |
| Browse follow-up ("what options?") | No structured attr flagged missing |
| Free-form gap (ingredients) | Still escalates (LLM free-form path preserved) |
| Fail-closed / errored assessor | Escalation timing unchanged; **generic** notice, no wrong attr |
| Multi-product, attr present for some / absent for others | Per-product pass escalates the *requested* attr only |
| NULL vs empty-string column | Empty strings already coerced to NULL; treated as missing |
| Albanian inflected request ("shijen", "markën", "ngjyrash") | Detected deterministically |

---

## 6. Behavior changes worth noting

- **On the exact test product**, the fix now returns the correct grounded reply (flavor *is*
  derivable from the name "Limon") rather than a spurious notice. Blank-column attributes whose
  value is stated in the product **name** are intentionally treated as answerable
  (`NAME_ATTRIBUTE_PATTERNS`, preserved). Making a blank column *always* escalate regardless of
  the name would be a separate policy decision.
- Applying the filter on the default path also makes bare, ambiguous free-form nutrition words
  ("kalori", "proteina") fail soft — they are deliberately excluded from `FREE_FORM_INFO_STEMS`
  (the RC-01 false-escalation drivers in a supplements catalog). Multi-word forms ("sa kalori
  ka", "calorie content") still escalate. Net effect: fewer false escalations, never a wrong
  attribute.

---

## 7. Verification (summary)

`typecheck` clean · `npm test` **2257 pass / 0 fail** (incl. new
`partialAnswerLabelSanitation.test.ts` + extended `productRetrieval.test.ts`) ·
`npm run eval:golden` RC-01 digest deterministic across 3 runs · `config:check` OK. Live
reproduction against the **real OpenAI classifier + real DB rows** confirms no scenario names an
unrequested attribute, while genuinely-missing requested attributes are still named correctly.
Full table in [ATTRIBUTE-MISLABEL-VALIDATION.md](ATTRIBUTE-MISLABEL-VALIDATION.md).
