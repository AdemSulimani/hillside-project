/**
 * P3-4 — the golden gap-gate corpus (RC-01, RC-25).
 *
 * WHAT THE AUDIT MEASURED, AND WHAT THIS PINS. Phase 10's live replay ran the product-information
 * gap assessor eight times per input against the real dev catalog:
 *
 *   IN1  "A keni proteine Compact whey gold?"  → escalate 8/8, missing=['marka']
 *        …though `brand` is NULL on every matched row and the customer asked only about availability.
 *   IN2  "Sa kushton whey Applied Nutrition…"  → answer 0/8 escalations (the control)
 *   IN3  "Cila kreatine eshte me e mire…"      → escalate 8/8, with the REASON itself varying at
 *        temperature 0 (4×['cila eshte me e mire'], 4×['më e mirë'])
 *
 * Every one of those escalations was wrong: the catalog could answer the question. That is RC-01,
 * the top measured driver of the audit's Issue-1 answer-vs-escalate split, and this corpus is its
 * standing regression guard.
 *
 * DIALECT COVERAGE IS NOT DECORATION. The remediation plan asks for "Albanian+Gheg+English", and
 * RC-25 explains why: the platform's core market is Kosovo, the classifier prompts are all English,
 * and the dialect regexes omitted Gheg forms — so the Gheg arm is where escalation defects surface
 * FIRST. Gheg cases are drawn from EV-030 (the 40 most recent real customer messages in the dev DB,
 * 39/40 Albanian, and — the fact that shapes everything — 0/40 carrying Albanian diacritics).
 *
 * TRUE GAPS ARE PART OF THE CORPUS. A suite containing only answerable questions would pass just as
 * well against a gate that never escalates at all. `GOLDEN_TRUE_GAPS` is what stops that: each case
 * has a genuinely absent structured attribute and MUST still escalate.
 *
 * OWNER: AI platform. New failure classes become cases here.
 * Pure data — no DB, network or OpenAI key.
 */
import type { GapGateCase } from './types';

/**
 * Answerable questions. Every one of these must resolve to "send the AI's reply as-is" on every
 * adversarial assessor draw. Product rows mirror the real dev catalog (EV-013).
 */
export const GOLDEN_ANSWERABLE: readonly GapGateCase[] = [
  // --- Standard/urban Albanian -------------------------------------------------------------
  {
    id: 'IN1',
    text: 'A keni proteine Compact whey gold?',
    gloss: 'Do you have Compact Whey Gold protein?',
    locale: 'sq',
    dialect: 'standard',
    requested: [], // plain availability — no structured attribute asked
    products: [
      { brand: null, flavor: 'Limon', weight: '1kg' },
      { brand: null, flavor: 'Portokall', weight: '1kg' },
    ],
    expect: 'answer',
    rationale:
      'Availability only. brand is null on every row but was never requested — the assessor flagged ' +
      "missing=['marka'] on 8/8 runs anyway. The deterministic net must veto that.",
    source: 'EV-044 / 10-runtime-verification.md IN1 (escalate 8/8)',
  },
  {
    id: 'IN2',
    text: 'Sa kushton whey Applied Nutrition dhe qfar shije keni?',
    gloss: 'How much does Applied Nutrition whey cost and what flavours do you have?',
    locale: 'sq',
    dialect: 'standard',
    requested: ['flavor'],
    products: [
      { brand: 'Applied Nutrition', flavor: 'Çokollatë', weight: '2kg' },
      { brand: 'Applied Nutrition', flavor: 'Vanilje', weight: '2kg' },
      { brand: 'Applied Nutrition', flavor: 'Luleshtrydhe', weight: '2kg' },
    ],
    expect: 'answer',
    rationale:
      'The control case: the audit measured 0/8 escalations here. Flavour is present on every row, ' +
      'so it must stay answerable — a regression that escalated this would be unmistakable.',
    source: 'EV-044 / 10-runtime-verification.md IN2 (answer 0/8)',
  },
  {
    id: 'IN3',
    text: 'Cila kreatine eshte me e mire, Creatine Monohydrate apo BSN Creatine?',
    gloss: 'Which creatine is better, Creatine Monohydrate or BSN Creatine?',
    locale: 'sq',
    dialect: 'standard',
    requested: [],
    products: [
      { brand: null, flavor: 'Pa shije', size: '250gr' },
      { brand: 'BSN', flavor: 'Pa shije', size: '300gr' },
    ],
    expect: 'answer',
    rationale:
      'A comparison question. The assessor echoed the QUESTION back as a missing attribute — and did ' +
      'so non-deterministically at temperature 0. A question echo names no catalog attribute and must ' +
      'never escalate.',
    source: 'EV-044 / 10-runtime-verification.md IN3 (escalate 8/8, 2 distinct reasons)',
  },
  {
    id: 'SQ-01',
    text: 'A keni carbo one',
    gloss: 'Do you have Carbo One?',
    locale: 'sq',
    dialect: 'standard',
    requested: [],
    products: [{ brand: null, flavor: 'Limon', weight: '1kg' }],
    expect: 'answer',
    rationale: 'Plain availability of an active, in-stock row.',
    source: 'EV-015 (conv 3ea2ace9 turn 1) / EV-030',
  },
  {
    id: 'SQ-02',
    text: 'Me qfar shije i keni edhe sa kushtojn',
    gloss: 'What flavours do you have them in, and how much do they cost?',
    locale: 'sq',
    dialect: 'standard',
    requested: ['flavor'],
    products: [
      { brand: null, flavor: 'Limon', weight: '1kg' },
      { brand: null, flavor: 'Portokall', weight: '1kg' },
    ],
    expect: 'answer',
    rationale:
      'Flavour is present on BOTH rows, so the per-product pass is clear too. This is the turn that ' +
      'produced the EV-011 hallucinated_price false positive downstream.',
    source: 'EV-030 (convs 28bec994, cf2bf59a, 92cd366e, 3ea2ace9)',
  },
  {
    id: 'SQ-03',
    text: 'Pershendetje a keni whey protein edhe me qfar shije',
    gloss: 'Hello, do you have whey protein and in what flavours?',
    locale: 'sq',
    dialect: 'standard',
    requested: ['flavor'],
    products: [
      { brand: null, flavor: 'Çokollatë', weight: '2kg' },
      { brand: null, flavor: 'Vanilje', weight: '2kg' },
    ],
    expect: 'answer',
    rationale: 'Availability + a structured attribute the catalog carries on every row.',
    source: 'EV-030 (conv 98571d00)',
  },
  {
    id: 'SQ-04',
    text: 'Sa kushton kjo shef',
    gloss: 'How much does this cost, boss?',
    locale: 'sq',
    dialect: 'standard',
    requested: [],
    products: [{ brand: null, flavor: 'Limon', weight: '1kg' }],
    expect: 'answer',
    rationale: 'A price question asks for no structured attribute — price is not a gap-gate concern.',
    source: 'EV-030 (conv 1e71b190)',
  },
  {
    id: 'SQ-05',
    text: 'Pershendefje a keni carbo one',
    gloss: 'Hello [typo], do you have Carbo One?',
    locale: 'sq',
    dialect: 'standard',
    requested: [],
    products: [{ brand: null, flavor: 'Portokall', weight: '1kg' }],
    expect: 'answer',
    rationale:
      'A real typo variant, sent twice. Included because a misspelling must not change the outcome ' +
      'class — the audit found identical inputs diverging, and near-identical ones must not either.',
    source: 'EV-030 (typo variant, sent twice)',
  },

  // --- Kosovo/Gheg (RC-25: the core market, and where defects surface first) ----------------
  {
    id: 'GH-01',
    text: 'A keni ma shum a veq aito\nQito',
    gloss: 'Do you have more, or only these? / These',
    locale: 'sq',
    dialect: 'gheg',
    requested: [],
    products: [
      { brand: null, flavor: 'Çokollatë', weight: '3kg' },
      { brand: null, flavor: 'Vanilje', weight: '3kg' },
    ],
    expect: 'answer',
    rationale:
      "P2-5's headline regression. Inventory browsing — 'more' is not a catalog attribute. The " +
      "English-prompted assessor filed missing_info:['ma shum'] to a human specialist.",
    source: 'EV-010 (alert d3db5dac)',
  },
  {
    id: 'GH-02',
    text: 'A keni naj kreatin',
    gloss: 'Do you have any creatine?',
    locale: 'sq',
    dialect: 'gheg',
    requested: [],
    products: [{ brand: null, flavor: 'Pa shije', size: '250gr' }],
    expect: 'answer',
    rationale: 'Gheg availability question over an active row.',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    id: 'GH-03',
    text: 'Hej a keni naj produkt tmir per shtim peshe se hiq sun po shtoj killa o shef qr',
    gloss: "Do you have a good weight-gain product? I can't put on any kilos",
    locale: 'sq',
    dialect: 'gheg',
    requested: [],
    products: [
      { brand: null, flavor: 'Çokollatë', weight: '3kg' },
      { brand: null, flavor: 'Vanilje', weight: '3kg' },
    ],
    expect: 'answer',
    rationale: 'Category browsing in heavy Gheg with slang. Answerable from the catalog.',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    id: 'GH-04',
    text: 'Cilen mkishe than ti me marr prej qitynve',
    gloss: 'Which of these would you tell me to take?',
    locale: 'sq',
    dialect: 'gheg',
    requested: [],
    products: [
      { brand: null, flavor: 'Çokollatë', weight: '3kg' },
      { brand: null, flavor: 'Çokollatë', weight: '6kg' },
    ],
    expect: 'answer',
    rationale:
      'A recommendation request, not a fact request. This exact turn produced the fcd0af7e ' +
      'name-guard false positive two layers downstream.',
    source: 'EV-011/EV-015 (conv fcd0af7e turn 5)',
  },
  {
    id: 'GH-05',
    text: 'Qfar shije i kan edhe sa kushtojn',
    gloss: 'What flavours do they have and how much do they cost?',
    locale: 'sq',
    dialect: 'gheg',
    requested: ['flavor'],
    products: [
      { brand: null, flavor: 'Mjedër', size: '30 servime' },
      { brand: null, flavor: 'Bostan', size: '30 servime' },
    ],
    expect: 'answer',
    rationale: 'Gheg attribute question; flavour present on every row.',
    source: 'EV-030 (conv 6a120665)',
  },
  {
    id: 'GH-06',
    text: 'Cila o ma e lira be se le qe jom cpirr po edhe fikan hahahahahah',
    gloss: "Which is the cheapest? I'm broke",
    locale: 'sq',
    dialect: 'gheg',
    requested: [],
    products: [
      { brand: null, flavor: 'Limon', weight: '1kg' },
      { brand: null, flavor: 'Çokollatë', weight: '3kg' },
    ],
    expect: 'answer',
    rationale: 'A price-ordering request in dense Gheg. No structured attribute is being asked for.',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    id: 'GH-07',
    text: 'Aha okej a muna shef me porosit qita me shije mjedre',
    gloss: 'Ok, can I order this one in raspberry flavour?',
    locale: 'sq',
    dialect: 'gheg',
    requested: ['flavor'],
    products: [{ brand: null, flavor: 'Mjedër', size: '30 servime' }],
    expect: 'answer',
    rationale: 'An order intent naming a flavour the catalog carries. Must not be read as a gap.',
    source: 'EV-030 (conv 1d001d46)',
  },
  {
    id: 'GH-08',
    text: 'pershendetje a keni nitro tech ripped',
    gloss: 'Hello, do you have Nitro Tech Ripped?',
    locale: 'sq',
    dialect: 'gheg',
    requested: [],
    products: [{ brand: 'MuscleTech', flavor: 'Çokollatë', weight: '2kg' }],
    expect: 'answer',
    rationale: 'Named-product availability.',
    source: 'EV-030 (conv d1d12b10)',
  },

  // --- English (the platform fully supports it; the classifier prompts are English) ---------
  {
    id: 'EN-01',
    text: 'Do you have creatine in stock?',
    gloss: '(English)',
    locale: 'en',
    dialect: 'english',
    requested: [],
    products: [{ brand: null, flavor: 'Unflavoured', size: '250gr' }],
    expect: 'answer',
    rationale: 'The English control for GH-02 — same question, same catalog, same outcome required.',
    source: 'IN1-derived English arm (remediation plan: Albanian+Gheg+English)',
  },
  {
    id: 'EN-02',
    text: 'What flavours does the whey come in?',
    gloss: '(English)',
    locale: 'en',
    dialect: 'english',
    requested: ['flavor'],
    products: [
      { brand: null, flavor: 'Chocolate', weight: '2kg' },
      { brand: null, flavor: 'Vanilla', weight: '2kg' },
    ],
    expect: 'answer',
    rationale: 'Structured attribute present on every row.',
    source: 'IN2-derived English arm',
  },
  {
    id: 'EN-03',
    text: 'Which of these two would you recommend?',
    gloss: '(English)',
    locale: 'en',
    dialect: 'english',
    requested: [],
    products: [
      { brand: null, flavor: 'Chocolate', weight: '3kg' },
      { brand: 'BSN', flavor: 'Chocolate', weight: '3kg' },
    ],
    expect: 'answer',
    rationale: 'The English control for IN3 — a recommendation request, not a fact gap.',
    source: 'IN3-derived English arm',
  },
];

/**
 * Genuinely unanswerable questions. These MUST still escalate — the anti-vacuity half of the corpus.
 * Without them a gate that simply never escalates would pass the answerable set perfectly.
 */
export const GOLDEN_TRUE_GAPS: readonly GapGateCase[] = [
  {
    id: 'GAP-01',
    text: 'Qfar ngjyre e ka kutia?',
    gloss: 'What colour is the box?',
    locale: 'sq',
    dialect: 'gheg',
    requested: ['color'],
    products: [{ brand: null, flavor: 'Limon', weight: '1kg', color: null }],
    expect: 'escalate',
    rationale: 'colour is requested and genuinely null on the only matched row — a real structured gap.',
    source: 'P0-3 true-gap control (deterministic net positive)',
  },
  {
    id: 'GAP-02',
    text: 'Sa peshon kjo?',
    gloss: 'How much does this weigh?',
    locale: 'sq',
    dialect: 'standard',
    requested: ['weight'],
    products: [{ brand: null, flavor: 'Çokollatë', weight: null }],
    expect: 'escalate',
    rationale: 'weight requested, absent from the catalog row and from packaging reads.',
    source: 'P0-3 true-gap control',
  },
  {
    id: 'GAP-03',
    text: 'Qfar shije i keni?',
    gloss: 'What flavours do you have?',
    locale: 'sq',
    dialect: 'standard',
    requested: ['flavor'],
    products: [
      { brand: null, flavor: 'Limon', weight: '1kg' },
      { brand: null, flavor: null, weight: '1kg' }, // second row has no flavour
    ],
    expect: 'escalate',
    rationale:
      'The PER-PRODUCT pass: flavour is present for one matched product and absent for the other. ' +
      'A multi-product answer that silently covers only half the set is the defect this catches.',
    source: 'P0-3 per-product-gap control',
  },
  {
    id: 'GAP-04',
    text: 'What size options are there?',
    gloss: '(English)',
    locale: 'en',
    dialect: 'english',
    requested: ['size'],
    products: [{ brand: null, flavor: 'Chocolate', size: null }],
    expect: 'escalate',
    rationale: 'The English true-gap control — a real gap must escalate in every locale.',
    source: 'P0-3 true-gap control (English arm)',
  },
];

/** The whole corpus. */
export const GOLDEN_CORPUS: readonly GapGateCase[] = [...GOLDEN_ANSWERABLE, ...GOLDEN_TRUE_GAPS];

/**
 * IN1 and IN3 are the two inputs the audit measured escalating 8/8. The RC-01 meta-test asserts the
 * pre-fix policy reproduces that and the post-fix policy does not, so they are named explicitly
 * rather than found by filtering — a filter that stopped matching would silently empty the meta-test.
 */
export const AUDIT_8_OF_8_CASE_IDS: readonly string[] = ['IN1', 'IN3'];
