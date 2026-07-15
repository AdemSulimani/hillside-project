/**
 * P2-5 (RC-25, RC-10): curated Kosovo/Gheg forms for the deterministic routing layer.
 *
 * The existing lexicons are standard-Albanian (Tosk) biased, so Gheg phrasings slip every
 * regex and fall through to the English-prompted LLM assessors. EV-010 is the canonical
 * miss: "A keni ma shum a veq aito / Qito" ("do you have more, or only these?") matched
 * nothing — 'ma shum' misses `me shum[eë]`, 'aito'/'qito' miss the deictic list — so an
 * inventory-browsing question entered the product-information-gap path and the assessor
 * returned `missing_info: ["ma shum"]`: the word "more" reported to a specialist as an
 * unavailable catalog attribute.
 *
 * DESIGN — every export here is ADDITIVE. These lists are concatenated onto the legacy
 * lexicons, never substituted for them, so:
 *   - flag-off is byte-identical (the legacy arrays are untouched), and
 *   - flag-on can only ever match MORE, never less (the regression risk stated in the
 *     remediation plan: "Lexicon additions can only catch more Gheg").
 * The one residual risk — a false consent/cancel match — is why consent additions go only
 * to the order_stage FSM's copy, which is stage-gated to `awaiting_confirmation`. See
 * `orderStageMachine.ts` and the note on `looksLikeOrderAffirmation` below.
 *
 * DIACRITICS — every consumer normalizes with an NFD + `\p{M}` strip before testing, so a
 * pattern here must never contain ë or ç: those alternates are unreachable. The legacy
 * lists are full of such dead alternates (`çfarë`, `ket[eë]`, `vet[eë]m`); they are left
 * in place (dead code is harmless and removing it is a separate, flag-independent
 * cleanup), but `ghegLexicons.test.ts` pins the property for everything added here.
 *
 * Sources: EV-030 (40-message Gheg traffic profile), EV-031 (catalog field language),
 * EV-010 (the alert payloads), RC-25. Kept as literal forms as typed by real customers —
 * 0 of 40 real messages carry Albanian diacritics.
 */

export const GHEG_LEXICONS = (process.env.GHEG_LEXICONS ?? 'false').trim().toLowerCase() === 'true';

/**
 * Concatenates the Gheg extras onto a legacy list when enabled. Additive by construction.
 *
 * `enabled` is an explicit parameter (defaulting to the module-scope flag) so the flag-on
 * composition is testable as a pure function — the flag itself is frozen at module load and
 * cannot be toggled from a test. Flag-off returns the SAME array reference, so byte-identity
 * is assertable by `assert.equal` rather than by deep comparison.
 */
export function withGhegPatterns(
  base: RegExp[],
  extra: RegExp[],
  enabled: boolean = GHEG_LEXICONS,
): RegExp[] {
  return enabled ? [...base, ...extra] : base;
}

/** Concatenates Gheg marker strings onto a legacy list when enabled. See `withGhegPatterns`. */
export function withGhegMarkers(
  base: readonly string[],
  extra: readonly string[],
  enabled: boolean = GHEG_LEXICONS,
): string[] {
  return enabled ? [...base, ...extra] : [...base];
}

/**
 * Extras for `OTHER_OPTIONS_FOLLOW_UP_PATTERNS` (productRetrievalService).
 *
 * Deliberately bounded: 'ma' is only ever accepted immediately before a quantity word, and
 * the Gheg deictics only ever after `veq|vetem`. Never as bare tokens — a bare 'ma' would
 * fire on the catalog's own "Serious Mass".
 */
export const GHEG_OTHER_OPTIONS_EXTRA_PATTERNS: RegExp[] = [
  // Gheg "ma shum" (= standard "më shumë", "more"). The legacy `me shum[eë]` requires both
  // the Tosk 'me' AND a trailing vowel, so it misses the bare Gheg form entirely.
  // THE EV-010 MISS.
  /\b(ma|me)\s+(shum|shume|shumica|tjera|tjetra|alternativa|opsione)\b/i,
  // Gheg deictics after "veq/vetem" (= "only these?"). Legacy covers qita|keto|ket[eë]|ata|to;
  // 'qito' and the real typo 'aito' (both in the EV-010 message) are absent, as are
  // 'qeto'/'qeta'/'kto'.
  /\b(veq|vetem)\s+(qito|qeto|qeta|aito|kto|qito)\b/i,
  // Bare deictic turn — EV-010's second line is literally just "Qito".
  /^(qito|qita|qeto|qeta|kto|aito)$/i,
  // Clitic "a e keni ... tjera" — 'a e keni' is common in real traffic and the legacy
  // `(a\s+keni|keni)\s+(tjera|tjetra)` requires the verb immediately before the noun.
  /\ba\s+e\s+keni\s+(edhe\s+)?(tjera|tjetra|qito|qita|qeto|kto)\b/i,
  // Gheg "naj tjeter" (= "ndonjë tjetër", "any other").
  /\bnaj\s+(tjeter|tjetra|tjera)\b/i,
];

/**
 * Extras for `ATTRIBUTE_FOLLOW_UP_PATTERNS` (productRetrievalService).
 * Gheg interrogatives for "çfarë": qfar / qfare / qka / qa.
 */
export const GHEG_ATTRIBUTE_FOLLOW_UP_EXTRA_PATTERNS: RegExp[] = [
  /\b(qfar|qfare|qka|qa)\s+(shije(?:t|sh)?|flavou?rs?|tastes?)\b/i,
  /\b(qfar|qfare|qka|qa)\s+(madhesi(?:t|ve)?|sizes?)\b/i,
  /\b(qfar|qfare|qka|qa)\s+(ngjyra(?:t|ve)?|colou?rs?)\b/i,
  /\b(qfar|qfare|qka|qa)\s+(variantet?|variants?)\b/i,
  /\b(qfar|qfare|qka|qa)\s+(marka(?:t|ve)?|brands?)\b/i,
  /\b(qfar|qfare|qka|qa)\s+(pesha(?:t|ve)?|weights?)\b/i,
  /\b(qfar|qfare|qka|qa)\s+(lloje(?:t|ve)?|types?)\b/i,
  /\b(qfar|qfare|qka|qa)\s+(opsione(?:t|ve)?|options?)\b/i,
];

/**
 * Extras for `RECOMMENDATION_COMPARISON_PATTERNS` (productDescriptionPromptService).
 *
 * That list is already the most Gheg-aware in the repo — it accepts the `(me|ma)`
 * alternation and the `[cq]mim` spelling. Its one gap: the copula. The comment at :122
 * claims "cila osht ma e lira" is detected, but :111 requires the literal Tosk 'eshte',
 * so 'osht'/'asht' reach that pattern and miss.
 */
export const GHEG_RECOMMENDATION_EXTRA_PATTERNS: RegExp[] = [
  // "cila osht ma e lira" — Gheg copula (osht/asht/o) in the "which is more ..." frame.
  /\b(cili|cila|cilin|cilen|cilat)\s+(osht|oshte|asht|o)\s+(me|ma)\b/i,
  // "cilen mkishe than ti me marr prej qitynve" — the deictic tail 'qitynve' (= "këtyre").
  /\b(cilen|cilin|cilat|cila)\b.{0,80}\b(qitynve|ktyne|qityne|ktynve)\b/i,
];

/**
 * Extras for `hasPostPurchaseIssueCue` (processAIReply).
 *
 * The sibling `hasDeliveryEtaOnlyCue` already accepts `ska|s'ka`; `hasPostPurchaseIssueCue`
 * accepts only 'nuk'. The inconsistency between two cues reading the same message IS the
 * bug — a Gheg "ska ardh" is a post-purchase complaint to one and invisible to the other.
 */
export const GHEG_POST_PURCHASE_EXTRA_PATTERNS: RegExp[] = [
  // Gheg negation: "ska ardh", "s'ka mberrit", "sme ka ardh", "nuk mka ardh"
  /(ska|s ka|sme|s me|nuk mka|nuk m ka|smka)\s*(ka\s+)?(ardh|ardhur|mberrit|mberritur)/,
  // Gheg copula in the wrong-product frame: "nuk osht produkti qe kam porosit"
  /(nuk|s)\s*(osht|asht)\b.{0,30}\b(produkt|artikull|porosi)/,
  // "qka bone me porosine time" / "qa bone me porosin" — Gheg "what happened with my order"
  /\b(qka|qa|qfar|qfare)\s+(bone|bo|u\s+ba)\b.{0,30}\b(porosi|porosin|porosine|paketa)/,
];

/**
 * Gheg markers for `heuristicallyDetectLanguage` (aiService) — the RC-10 half of P2-5.
 *
 * Verified against EV-030: "Qysh o moti sot", "O shef qa bone" and
 * "Cila o ma e lira be se le qe jom cpirr" all resolve to `null` today (no marker hits),
 * which costs a paid LLM language call per message — and under P2-2's `STICKY_LOCALE_SLOT`
 * this heuristic is the SOLE inbound-marker source (the LLM call is skipped entirely), so
 * a null silently keeps the previous locale instead of steering it.
 *
 * ⚠️ EVERY ENTRY MUST BE SAFE AS AN ENGLISH SUBSTRING. ⚠️
 *
 * Matching is bare `.includes()` over lowercased, diacritic-stripped text with a
 * `hits >= 1 && hits > otherHits` tiebreak — so ONE marker embedded in an ordinary English word
 * flips an English conversation to Albanian. This is not hypothetical: the first draft of this
 * list carried ' be ', 'sun', 'spo' and 'bone', and measurably broke real English messages —
 *
 *     "Can this be delivered tomorrow?"   null -> sq   (' be ')
 *     "Can it be shipped on Sunday?"      null -> sq   ('sun' in "Sunday", ' be ')
 *     "Would this be cheaper?"            en   -> null (' be ' cancelling 'cheaper')
 *     "Do you have sports nutrition?"     en   -> null ('spo' in "sports")
 *     "Is bone broth available?"          en   -> null ('bone')
 *
 * — i.e. it reintroduced RC-10, the exact defect this workstream exists to fix. Those four are
 * removed and `ghegLexicons.test.ts` now pins an English control corpus so the class cannot come
 * back. When adding a marker, ask: can this appear inside an English word or as an English word?
 * If yes, either pad it with spaces (' ma ' — bare 'ma' sits inside "Serious Mass") or drop it.
 * The Gheg forms below are all orthographically impossible in English.
 */
export const GHEG_ALBANIAN_MARKERS: readonly string[] = [
  // Copula / auxiliaries. ('kem' dropped — too short to be safe as a bare substring.)
  'osht', 'asht', 'jom', 'kena',
  // Interrogatives — 'qfar'/'qka'/'qysh' have no English substring collisions (q is never
  // followed by f/k/y in English).
  'qysh', 'qfar', 'qka',
  // Modals — 'muna/muni/munesh' (= mund), all Gheg-specific spellings.
  'muna', 'munesh',
  // Negation. NOT 'ska' (sits inside "Alaska"), NOT 'sun' (Sunday/sunscreen/sunflower),
  // NOT 'spo' (sports/spoon/response) — all three are English substrings.
  'spe di',
  // Quantifiers / deictics / adverbs — padded where the bare form is short.
  ' naj ', ' veq ', 'qita', 'qito', 'qikjo', 'qeto',
  // The Gheg comparative — padded: bare 'ma' is a substring of countless product names.
  ' ma ', 'ma e lir', 'ma shum', 'ma mir',
  // Vocative. NOT ' be ' — "be" is a top-20 English word and was flipping English to Albanian.
  ' shef',
  // Verbs. NOT 'bone' (bone broth), NOT 'baj'/'boj' alone (too short); the Gheg imperative is
  // kept only in its unambiguous inflected forms.
  'tmir', 'qa bone', 'qka bone',
];

/**
 * English control corpus — plain English messages that MUST NOT be flagged Albanian.
 * Exported so the marker list is regression-tested against it (see `ghegLexicons.test.ts`).
 * Every entry here broke against the first draft of GHEG_ALBANIAN_MARKERS.
 */
export const ENGLISH_CONTROL_MESSAGES: readonly string[] = [
  'Can this be delivered tomorrow?',
  'Would this be cheaper?',
  'Do you have sports nutrition?',
  'Is bone broth available?',
  'Can it be shipped on Sunday?',
  'I want to order this product',
  'What is the price of this?',
  'Is it in stock?',
  'Can you send me a photo?',
  'Please cancel my order',
];

/**
 * Extra order-consent patterns for `detectOrderConsentLexical` (orderStageMachine).
 *
 * SAFETY: these are added ONLY to the FSM's copy, which the machine honors ONLY in
 * `awaiting_confirmation` (the "po-in-a-complaint" guard) — so a stray Gheg affirmation in
 * open conversation can never create an order. That stage gate is what makes a consent
 * lexicon safe to widen at all.
 *
 * They are deliberately NOT added to the legacy `looksLikeOrderAffirmation`
 * (processAIReply): that function is called on BOTH flag branches and is NOT stage-gated,
 * so a token there would fire on any turn. `ghegLexicons.test.ts` pins it unchanged.
 */
export const GHEG_ORDER_CONSENT_EXTRA_PATTERNS: RegExp[] = [
  // Leading Gheg filler before the affirmation — "Aha okej ...", "E po mire ...".
  // The legacy list anchors on ^(po|ok|okej|...) so any filler defeats it.
  /^(aha|ehe|e po|hajde|hajt|hajde po)\s+(okej|ok|po|mire|dakord|bone|boje)\b/,
  // "pe porositi" / "po e porosis" / "pe marr" — Gheg progressive "I'm ordering it".
  // EV-030: "Okej qita pe porositi pra shef".
  /\b(pe|po e|po)\s+(porositi|porosis|porosit|marr)\b/,
  // "e du" / "e dua" — Gheg "I want it" as a bare confirmation.
  /^(qito|qita|kjo|kete)?\s*e\s+du(a)?\b/,
  // "jom dakord" — Gheg copula + agreement.
  /^jom\s+dakord\b/,
  // "n'rregull" typed without the apostrophe the legacy 'nrregull' expects.
  /^n\s+rregull\b/,
];
