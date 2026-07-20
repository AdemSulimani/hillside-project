/**
 * P3-4 — the fabrication corpus (RC-03).
 *
 * ⚠️ THIS CORPUS HAS NO PRE-FIX/POST-FIX SWITCH, AND THAT IS NOT AN OVERSIGHT.
 *
 * RC-01's meta-test flips a flag; RC-02's flips an injected reference set. RC-03 has neither,
 * because there was never a checker to turn off. The fabrication came out of the MODEL: Phase 10
 * replayed one fixed prompt eight times at `AI_REPLY_TEMPERATURE=0.3` and IN3 produced eight
 * different paragraphs, several asserting "BSN = Bio-Engineered Supplements and Nutrition" plus
 * strength claims absent from the catalog. No code path produced them and no code path caught them:
 * the product-name guard checks only NAMES, and the quality eval scored these replies 0.95.
 *
 * So the meta-test here is necessarily corpus-based — run the NEW checker over the RECORDED pre-fix
 * text and assert it flags. `fabricated` cases are the positives; `grounded` cases are the negatives
 * that keep the checker honest. A reader who assumes "flag off = pre-fix" will misread this file.
 *
 * WHY THE NEGATIVE SET IS THE LOAD-BEARING HALF. A fabrication checker is trivially made to flag
 * everything. What makes it a usable release gate is that it stays silent on real, correct Albanian
 * replies — so `GROUNDED_REPLIES` is drawn from actually-delivered AI messages (EV-015, EV-030) and
 * every one must produce ZERO violations. Any violation found here is either a real fabrication
 * (keep it, it is evidence) or an allowlist gap (fix the allowlist, citing the reply that motivated
 * it). The allowlist grows only this way, never speculatively.
 *
 * OWNER: AI platform.
 * Pure data. No DB, network or OpenAI key.
 */

/**
 * The catalog context block as it was injected into the IN3 prompt — the authoritative universe for
 * membership. The remediation plan's wording is "absent from the INJECTED catalog", so a claim the
 * model could not have read is a fabrication even if some unrelated row happens to contain it.
 */
export const IN3_INJECTED_CATALOG = [
  'MATCHING PRODUCTS:',
  '- Pure Creatine 250gr pa shije | brand: (none) | flavor: Pa shije | size: 250gr | price: 22.00',
  '- BSN Creatine 300gr | brand: BSN | flavor: Pa shije | size: 300gr | price: 28.00',
  '- Pure Creatine 100 capsul | brand: (none) | flavor: Pa shije | size: 100 caps | price: 19.00',
].join('\n');

export const IN3_CUSTOMER_TEXT =
  'Cila kreatine eshte me e mire, Creatine Monohydrate apo BSN Creatine?';

/** Catalog names for the IN3 context (what a full-catalog name index would contain). */
export const IN3_CATALOG_NAMES: readonly string[] = [
  'Pure Creatine 250gr pa shije',
  'BSN Creatine 300gr',
  'Pure Creatine 100 capsul',
];

export interface FabricationCase {
  readonly id: string;
  /** The reply text, as recorded. */
  readonly reply: string;
  /** Tokens/spans that MUST be reported. Asserted disjoint from the checker's allowlist. */
  readonly expectViolationSpans: readonly string[];
  /** Which extractor should catch it — asserted, so a violation of the wrong kind still fails. */
  readonly expectKinds: ReadonlyArray<'price' | 'name' | 'quantity'>;
  readonly source: string;
  readonly rationale: string;
}

/**
 * FABRICATING replies. Every one must produce at least one violation of the expected kind.
 */
export const FABRICATED_REPLIES: readonly FabricationCase[] = [
  {
    id: 'FAB-01-bsn-backronym',
    reply:
      'Të dyja janë të mira. BSN është shkurtesa e Bio-Engineered Supplements and Nutrition, një ' +
      'markë amerikane e njohur për cilësinë e saj.',
    expectViolationSpans: ['Bio-Engineered', 'Supplements', 'Nutrition'],
    expectKinds: ['name'],
    source: 'EV-044 / 10-runtime-verification.md IN3 (Phase B ×8 — fabricated in several runs)',
    rationale:
      'The headline RC-03 case. "BSN" itself IS in the catalog, so a naive check passes; the ' +
      'backronym expansion is invented and appears nowhere in the injected context. The name guard ' +
      'checks only product names and the quality eval scored this 0.95 — both waved it through.',
  },
  {
    id: 'FAB-02-invented-strength',
    reply: 'Pure Creatine 250gr pa shije jep 5000mg kreatinë për porcion dhe 60 porcione në paketë.',
    expectViolationSpans: ['5000mg', '60 porcione'],
    expectKinds: ['quantity'],
    source: 'EV-044 / IN3 (strength claims not in catalog)',
    rationale:
      'The product name and size are real; the per-serving strength and the serving count are both ' +
      'invented. This is the class a name-only guard structurally cannot see — which is exactly why ' +
      'the audit\'s fabricating IN3 replies passed the live name guard.',
  },
  {
    id: 'FAB-03-invented-price',
    reply: 'BSN Creatine 300gr kushton €31.90 aktualisht.',
    expectViolationSpans: ['31.90'],
    expectKinds: ['price'],
    source: 'RC-03 price-fabrication control (derived from the IN3 catalog)',
    rationale:
      'A real product with a price that is not its catalog price. Caught by the same parser the ' +
      'live price guard uses, so the harness and the gate cannot disagree about what a price is.',
  },
  {
    id: 'FAB-04-invented-brand',
    reply: 'Ju rekomandoj Optimum Nutrition Gold Standard, është më e mira në treg.',
    expectViolationSpans: ['Optimum', 'Nutrition', 'Gold', 'Standard'],
    expectKinds: ['name'],
    source: 'RC-03 invented-product control',
    rationale:
      'A wholly invented product recommendation. Every token of the invented name is reported ' +
      'individually, which is what makes the failure message actionable.',
  },
];

/**
 * GROUNDED replies — real delivered AI messages that must produce ZERO violations.
 * Each carries the catalog context it was generated against.
 */
export interface GroundedCase {
  readonly id: string;
  readonly reply: string;
  readonly injectedCatalog: string;
  readonly catalogNames: readonly string[];
  readonly customerText: string;
  readonly source: string;
}

const MASS_GAINER_CATALOG = [
  'MATCHING PRODUCTS:',
  '- Mass gainer 3kg Qokolad | brand: (none) | flavor: Qokolad | weight: 3kg | price: 52.00',
  '- Mega mass 3kg Qokolad | brand: (none) | flavor: Qokolad | weight: 3kg | price: 55.00',
  '- Mega mass 3kg Vanil | brand: (none) | flavor: Vanil | weight: 3kg | price: 55.00',
  '- Mega mass 7kg Qokolad | brand: (none) | flavor: Qokolad | weight: 7kg | price: 95.00',
  '- Critical Mass 6kg Keks | brand: (none) | flavor: Keks | weight: 6kg | price: 78.00',
  '- Pro Mass 1kg Qokolad | brand: (none) | flavor: Qokolad | weight: 1kg | price: 24.00',
].join('\n');

const MASS_GAINER_NAMES: readonly string[] = [
  'Mass gainer 3kg Qokolad',
  'Mega mass 3kg Qokolad',
  'Mega mass 3kg Vanil',
  'Mega mass 7kg Qokolad',
  'Critical Mass 6kg Keks',
  'Pro Mass 1kg Qokolad',
];

const CARBO_CATALOG = [
  'MATCHING PRODUCTS:',
  '- Carbo one 1kg Limon | brand: (none) | flavor: Limon | weight: 1kg | price: 18.00',
  '- Carbo One 1kg Orange | brand: (none) | flavor: Portokall | weight: 1kg | price: 18.00',
].join('\n');

const CARBO_NAMES: readonly string[] = ['Carbo one 1kg Limon', 'Carbo One 1kg Orange'];

export const GROUNDED_REPLIES: readonly GroundedCase[] = [
  {
    id: 'OK-01-fcd0af7e-turn2',
    reply:
      'Po, kemi disa produkte për shtim peshe. Disa nga opsionet përfshijnë:\n' +
      '- Mass gainer 3kg Qokolad\n- Mega mass 3kg Qokolad',
    injectedCatalog: MASS_GAINER_CATALOG,
    catalogNames: MASS_GAINER_NAMES,
    customerText: 'a keni produkte te mira per shtim peshe',
    source: 'EV-015 (conv fcd0af7e turn 2 — sent successfully)',
  },
  {
    id: 'OK-02-fcd0af7e-turn4',
    reply:
      'Po, kemi edhe disa produkte të tjera për shtim peshe, si:\n' +
      '- Critical Mass 6kg Keks\n- Pro Mass 1kg Qokolad',
    injectedCatalog: MASS_GAINER_CATALOG,
    catalogNames: MASS_GAINER_NAMES,
    customerText: 'a keni tjera a veq qito',
    source: 'EV-015 (conv fcd0af7e turn 4 — sent successfully)',
  },
  {
    id: 'OK-03-the-stripped-recommendation',
    reply:
      'Për shtim peshe, Mega mass 3kg Qokolad është një zgjedhje e shkëlqyer. Gjithashtu, Mass ' +
      'gainer 3kg Qokolad është një opsion i mirë. Çmimi fillon nga €52.00.',
    injectedCatalog: MASS_GAINER_CATALOG,
    catalogNames: MASS_GAINER_NAMES,
    customerText: 'Cilen mkishe than ti me marr prej qitynve',
    // ⚠️ ADAPTED, NOT VERBATIM. EV-011 stored `originalReplyPreview` truncated at 200 chars
    // ("…Mass gainer 3kg Qokolad ës"), so no complete recording of this reply exists. This version
    // shortens the middle clause and ADDS "Çmimi fillon nga €52.00." — €52.00 is a real catalog
    // price (EV-013), added so the case exercises the price arm as well as the name arm. Flagged
    // explicitly because the rest of this corpus IS verbatim and the distinction must not blur.
    source: 'EV-011 (alert ef3393c1 originalReplyPreview — the FALSE positive) — adapted, see note',
    // The whole point: this reply was stripped as "hallucinated". It is fully grounded, and the
    // fabrication checker must agree with the catalog, not with the alert.
  },
  {
    id: 'OK-04-the-stripped-price',
    reply: 'Shijet: Limon, Portokall. Çmimi: €18.00 për secilën.',
    injectedCatalog: CARBO_CATALOG,
    catalogNames: CARBO_NAMES,
    customerText: 'Me qfar shije i keni edhe sa kushtojn',
    source: 'EV-011 (alert e37cd2ce originalReplyPreview — the FALSE positive)',
  },
  {
    id: 'OK-05-degenerate-affirmative',
    reply: 'Po.',
    injectedCatalog: CARBO_CATALOG,
    catalogNames: CARBO_NAMES,
    customerText: 'Pershendetje a keni carbo one',
    source: 'EV-044 / IN1 (the degenerate reply that scored 0.20 and shipped)',
  },
  {
    id: 'OK-06-honest-negative',
    reply: 'Nuk kemi oferta aktive për momentin. Gjithashtu, mund t’ju ndihmoj me produktet e tjera.',
    injectedCatalog: CARBO_CATALOG,
    catalogNames: CARBO_NAMES,
    customerText: 'a keni ndonje produkt ne ofert be',
    source: 'EV-012 (alert 10946774 — uncertain_answer_escalated)',
  },
  {
    id: 'OK-07-english-grounded',
    reply: 'Yes, we have Carbo One 1kg Orange in stock. The price is €18.00.',
    injectedCatalog: CARBO_CATALOG,
    catalogNames: CARBO_NAMES,
    customerText: 'do you have carbo one',
    source: 'English-arm control (grounded)',
  },
  {
    id: 'OK-08-comparison-connective',
    // Verbatim from the 2026-07-20 dev-validation live replay (IN3 ×4 under the full grounding
    // stack, probe-u10b run 1). The sentence-initial "Zgjedhja" (definite form) flagged one false
    // violation per run — the allowlist carried only the indefinite 'zgjedhje'. This case is the
    // negative-corpus justification for the 'zgjedhja' allowlist entry. "Creatine Monohydrate" and
    // "BSN Creatine" are covered by the customer-echo exemption, exactly as in the live turn.
    reply:
      'Të dyja produktet, Creatine Monohydrate dhe BSN Creatine, janë të njohura për përmirësimin ' +
      'e performancës gjatë stërvitjes. Zgjedhja më e mirë varet nga preferencat tuaja personale ' +
      'dhe nevojat specifike. Nëse keni nevojë për më shumë detaje mbi secilin produkt, mund tju ' +
      'ndihmoj me informacione shtesë.',
    injectedCatalog: IN3_INJECTED_CATALOG,
    catalogNames: IN3_CATALOG_NAMES,
    customerText: IN3_CUSTOMER_TEXT,
    source: 'P0-P3 dev validation 2026-07-20, Finding 2 (live replay IN3 — the Zgjedhja FP)',
  },
];

/**
 * A token that exists in no catalog, no reply and no allowlist. The MUTATION GUARD: injecting it
 * into a known-good reply must produce a violation. Without this, an extractor that silently
 * stopped extracting would leave every negative case passing and look perfectly healthy.
 */
export const MUTATION_PROBE_TOKEN = 'Zzqfakebrandix';
