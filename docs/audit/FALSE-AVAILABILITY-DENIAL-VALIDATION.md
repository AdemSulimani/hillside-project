# False "product not available" denials — root cause, fix, live validation (2026-07-20)

Branch `fix/alert-noise-pause-policy`. Follow-up to `PRODUCT-IMAGE-REQUEST-VALIDATION.md`, which
first observed the quirk: **"Sa kushton nitro tech ripped?"** (an exact active catalog name,
€50.00) answered with *"nuk e kemi në dispozicion produktin Nitro Tech Ripped"* + alternatives
(conv `ee183c2e…`).

## Root cause (verified line-by-line)

1. `isPriceOnlyFollowUp` (aiService.ts) treats any ≤6-word message containing a price cue
   ("kushton") as a context-only follow-up — it never checks for an embedded product name.
2. `resolveContextualProductSet` then short-circuits on the previous AI turn's persisted
   `messages.product_ids` (10 pre-workout rows) — **fresh retrieval never runs**; the named
   product is absent from the injected pool.
3. Platform rule R6 + the filtered-subset note make the model deny anything not in the pool —
   a retrieval miss becomes a confident false "we don't carry it".
4. The last-chance guard ships it: `shouldEscalateUncertainAnswer` treats denial + populated
   context as "guideline-compliant" (the R13 alternatives carve-out) — nothing verified the
   **denied** name against the **full** catalog. Every existing guard points the other way
   (blocking *invented* products, never *denied real* ones).

## Fix (deterministic-first, no regeneration, no migration, no new knobs/alert reasons)

**Prong A — inbound-name pinning** (`services/inboundNamePinning.ts`, pure + injectable):
- `extractCandidateNameGrams`: tri/bi-grams from the folded message, stopword + price-cue edges
  trimmed, no uni-grams, cap 8, longest first.
- `resolveInboundNamedProducts`: per gram, raw ILIKE rung then stemmed-token rung (Albanian
  inflections — "nitro techin" → `%tech%`), each filtered by `productNameTokenMatch`; cap 3
  products / 6 lookups; never throws. Reuses `stemmedSearchTerm` / `bySpecificity` /
  `productNameTokenMatch` (hoisted + exported from productImageRequestService).
- Wired into `resolveContextualProductSet` (new `pinned` param): pinned products are PREPENDED
  on every exit path and can never be evicted by stale context. Runs only on
  contextual-resolver turns; ILIKE is index-backed (migration 044 gin_trgm).
- `generateReply` returns `inboundNamedProducts?` for the guard.

**Prong B — false-denial backstop**:
- `productsDeniedInReply` (inboundNamePinning.ts): **clause-scoped** denial matching — sentences
  split on terminal punctuation/newlines, then on contrast conjunctions (por/mirepo/but/…), and a
  pinned product counts only when mentioned inside a clause carrying denial wording. This is what
  lets an R13 reply deny X while OFFERING a pinned product as an alternative without tripping.
- `shouldEscalateUncertainAnswer` gains optional `deniedProductExistsInCatalog`; a denial of a
  verifiably-existing product escalates (before the alternatives carve-out, after the
  out-of-stock precedence). Escalation reuses the existing `uncertain_answer_escalated` wiring
  (pause + alert) with `details.kind: 'false_availability_denial'` + `denied_product_names` —
  zero new alert/pause sites, `alertPausePolicy.test.ts` count guards untouched.
- Genuine-denial invariant: a truly-not-carried product pins nothing → the signal is structurally
  impossible → R6/R13 behavior byte-identical to before.

## Offline validation

- `npm test`: **2226/2226** (471 suites) — 19 new tests in `inboundNamePinning.test.ts`
  (gram extraction, pinning ladder incl. inflected + budget + genuine-denial invariant,
  clause-scoped denial matching incl. the live reply verbatim), 4 new in
  `uncertainAnswerFallback.test.ts` (live-bug escalation, optional-field inertness, OOS
  precedence, exclusion precedence), 2 new in `replyAlternativesGrounding.test.ts`
  (false-denial vs genuine R13 side by side).
- `npm run typecheck` clean; `npm run config:check` OK (no knob changes).

## Live validation (dev backend, LIVETEST channel `aec28f9d…`, senders `…080-085`)

| # | Scenario | Result |
|---|---|---|
| 1 | **Exact repro** — Beast photo turn, then "Sa kushton nitro tech ripped?" (…080) | **"Nitro Tech Ripped kushton €50.00."** — no denial; `product_ids` = 10 persisted + 2 pinned; no pause. Pre-fix this exact sequence produced the false denial. |
| 2 | Cold-start "Sa kushton nitro tech ripped?" (…081) | "€50.00" (regression clean). |
| 3 | **Inflected** "Sa kushton nitro techin?" after Beast context (…082) | "Nitro Tech Ripped kushton €50.00." via the stemmed rung (13 = 10 persisted + 3 pinned). |
| 4 | Genuine not-carried "A keni ostrovit whey gold?" (…083) | R13 denial + 3 catalog alternatives ships; no escalation. (Routes through fresh fusion — pinning doesn't run there; the guard signal stays absent by construction.) |
| 5 | Bare follow-up "Sa kushton?" after a recommendation (…084) | Persisted-context answer "€50.00", zero pinning lookups — unchanged. |
| 6 | **Mixed** "Sa kushton ostroviti edhe nitro techi?" (…085) | "Ostroviti nuk është në katalogun tonë aktual. Ja çmimet për Nitro Tech: …" — fake product denied, all 5 pinned Nitro Tech variants priced (`product_ids` = 5 = exactly the pinned set), **no over-escalation** (clause-scoping working live). |

Post-run sweep 17:58–18:11 UTC: alerts = expected `message_send_failed` (fake page) + 2
`missing_image` photo alerts from setup turns; **zero** `uncertain_answer_escalated`, **zero**
paused conversations among senders …080-085.

The backstop's escalation branch (`kind: 'false_availability_denial'`) cannot be forced live once
pinning works — that is the design — and is pinned by the unit tests instead.

## Residual gap — CLOSED same day (fresh-path Albanianized names)

Follow-up probes quantified the "fresh non-contextual query" gap before fixing it:
- "A keni nitro techin?" (multi-token) was fine — the clean "nitro" token keyword-rescues it.
- **"A e keni kreatinen?" → reply "Po." over an EMPTY pool** (conv `64d7eb6c…`, sender …088):
  ILIKE cannot bridge the Albanianized k↔c spelling ("kreatinen" vs "Creatine", 24 catalog
  rows!), `ALBANIAN_CONTENT_VARIANTS` covers lemmas only, embeddings fell short, and the
  false-denial backstop was unarmed on this path (`inboundNamedProducts` only set on
  contextual turns).

Fix (same branch): `inboundNamePinning` extended — guarded uni-grams (≥5 chars, non-stopword,
only for tokens no multi-gram covers), interior-stopword gram drop, a **dialect-variant rung**
(stem "kreatinen" → curated variant "creatine" → ILIKE hit; the load-bearing bridge — trigram
similarity for this pair is ≈0.36, inside the fabrication band, so the floor was NOT lowered)
and a **trigram rung** for real typos at `INBOUND_PIN_SIMILARITY_THRESHOLD` (0.48, new knob);
new `resolveGramsToProducts` export; and a **fresh-path gap detector** in `generateReply`
(after fusion, gated `!isOtherOptionsRequest && !needsContextualResolver`): only grams no
fused row token-matches are resolved, hits are prepended, and `inboundNamedProducts` now arms
the backstop on fresh turns too. Zero DB cost on ordinary turns (no grams → no lookups).

Validation: `npm test` **2233/2233** (7 new/updated pinning tests incl. the kreatinen
variant-rung end-to-end through the REAL dialect map), typecheck + config:check clean (125
knobs). Live (senders …090-094): "A e keni kreatinen?" → *"Po, kemi kreatinë në dispozicion:
BSN Creatine 216gr, Creatine Monohydrate, dhe Creatine 500gr Qershi."* (3 pinned rows);
"A keni nitro techin?" unchanged (5 variants); mixed "kreatinen edhe nitro tech" → both
families (10 rows); contextual repro + bare follow-up still €50.00; "A keni ostrovit whey
gold?" still a clean R13 denial + alternatives with **no escalation** (the clause-scoped
backstop correctly ignored the trigram-pinned whey-gold rows offered as alternatives). Zero
pauses, zero `false_availability_denial` in the sweep.

Still deliberately untouched: `isPriceOnlyFollowUp` stays name-blind (pinning makes it
harmless), and no inflected forms were added to `ALBANIAN_CONTENT_VARIANTS` (the stem ladder
is the systematic bridge).

## Rollback

Revert the commits. No schema, knob, or alert-taxonomy changes; the resolver signature change is
internal to aiService; `deniedProductExistsInCatalog` is optional and inert when absent.
