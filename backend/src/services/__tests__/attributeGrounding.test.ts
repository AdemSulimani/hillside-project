/**
 * P3-1 — the declared-attribute grounding predicate.
 *
 * EVERY EVIDENCE FIXTURE BELOW IS REAL TEXT, copied from the dev catalog (tenant 02beb134, 257
 * active rows) and cited by product name. That matters more here than in most suites: the whole
 * design turns on empirical claims about how Albanian merchant descriptions are actually written
 * — that structured columns are empty, that support and contradiction co-occur, that a privative
 * is written as a coordinated list — and a suite of invented strings would confirm the design
 * against nothing.
 *
 * Pure: no DB, Redis, network or clock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  containsPhrase,
  parseAttributeClaim,
  locateClaimInProse,
  locateValueClaimInProse,
  segmentClauses,
  SUBSTANCE_LEXICON,
  SUPPORT_ONLY_BRIDGE,
  EXCLUSION_MARKERS,
  CONTRADICTION_MARKERS,
  NON_ASSERTIVE_FRAMES,
} from '../attributeClaimLexicon';
import {
  decideAttributeVerdicts,
  evaluateAttributeClaim,
  evaluateValueClaimMembership,
  evidenceForRow,
  tenantWideEvidence,
  type AttributeEvidence,
  type CatalogAttributeIndex,
  type CatalogAttributeRow,
} from '../attributeGrounding';
import { foldDialect } from '../dialectNormalization';
import { normalizeText } from '../productTitleNormalization';

// ---------------------------------------------------------------------------
// Real catalog text. Verified 2026-07-18 against tenant 02beb134.
// ---------------------------------------------------------------------------

/** `Mega mass 3kg Vanil` — the roadmap's own acceptance product. REFUTES "pa sheqer". */
const MEGA_MASS_VANIL =
  'Mega mass 3kg Vanil\nMass Gainer\n' +
  'Sheqer i reduktuar: Formula përmban karbohidrate komplekse dhe është më e ulët në sheqer ' +
  'krahasuar me formulën e vjetër të shtimit në peshë.';

/** `C4 Original 30 servime shije Bostani` — literal support. */
const C4_BOSTANI =
  'C4 Original 30 servime shije Bostani\nPre Workout\n' +
  'Pikat kryesore të formulës: Formula është pa sheqer dhe është projektuar për të ofruar ' +
  'energji të butë dhe të qëndrueshme.';

/**
 * `Green proten( protein bimore) 1140gr Dredhz` — a privative COORDINATED LIST: one leading "Pa"
 * governs sugar, dairy AND lactose. Supports both a "pa sheqer" and a "pa laktozë" claim.
 */
const GREEN_PROTEN =
  'Green proten( protein bimore) 1140gr Dredhz\nProteina\n' +
  '5 g karbohidrate dhe 1 g është nga fibrat dietike. Pa sheqer të shtuar, produkte qumështi, ' +
  'laktozë ose produkte shtazore. Pa aromë artificiale.';

/**
 * `Premium EAA zero(+BCAA) 325gr Lemonad` — carries BOTH signals for sugar: "pluhur pa sheqer"
 * and, later, "me sheqer të reduktuar". Support-first ordering is the only thing that keeps this
 * from being a false positive.
 */
const PREMIUM_EAA =
  'Premium EAA zero(+BCAA) 325gr Lemonad\nAminoacide\n' +
  'Weider Premium EAA Zero është një suplement pluhur pa sheqer, miqësor ndaj veganëve. ' +
  'I përshtatshëm për individët në një dietë me kalori të kontrolluara ose me sheqer të reduktuar.';

/**
 * `BEEF AMINO 300 Tableta` — the single most important false-positive fixture. It says BOTH
 * "pa Produkte Qumështi" (supports a lactose-free claim via the bridge) and "intoleranca ndaj
 * laktozës" (an AUDIENCE note that a naive matcher reads as a contradiction).
 */
const BEEF_AMINO =
  'BEEF AMINO 300 Tableta\nAminoacide\n' +
  'pa Produkte Qumështi: Një mundësi e shkëlqyer për atletët që vuajnë nga intoleranca ndaj ' +
  'laktozës, fryrja ose problemet e tretjes që lidhen me proteinat e hirrës ose kazeinës.';

/**
 * `Isolate protein 700gr qokolad` — the strongest SUPPORT-FIRST case in the real catalog, and a
 * cautionary one. One clause says the product is "plotësisht i ulët në karbohidrate, yndyrë dhe
 * laktozë" (LOW in lactose → would contradict "pa laktozë"); a later clause says "Pa laktozë, pa
 * gluten" (IS lactose-free → supports it). The merchant description is internally loose, and
 * support-first resolves it in the customer's favour.
 *
 * ⚠️ Both clauses are included on purpose. An earlier draft of this fixture carried only the first
 * one and asserted `contradicted` — reproducing, inside the test suite, the exact
 * "truncation manufactures flags" hazard `GROUNDING_ATTR_INDEX_MAX_ROWS` exists to prevent. Live
 * verification against the real row caught it. Do not shorten this fixture.
 */
const ISOLATE_PROTEIN =
  'Isolate protein 700gr qokolad\nProteina\n' +
  'Prodhohet duke përdorur teknologjinë e Mikrofiltrimit Cross-Flow, duke krijuar një burim ' +
  'proteine shumë të pastër që është plotësisht i ulët në karbohidrate, yndyrë dhe laktozë. ' +
  'Vetitë dietike: Pa laktozë, pa gluten dhe nuk përmban sheqerna të shtuar, duke e bërë shumë ' +
  'të tretshëm për individët me stomak të ndjeshëm ose intolerancë ndaj qumështit.';

/** `Applied Nutrition whey 2kg Qokolad` — genuinely REFUTES "pa sheqer" ("ka pak sheqer"). */
const APPLIED_WHEY =
  'Applied Nutrition whey 2kg Qokolad\nProteina\n' +
  'Applied Nutrition Critical Whey është një pluhur proteine me cilësi të lartë që ndihmon në ' +
  'ndërtimin e masës muskulore, ka pak sheqer dhe yndyrë dhe përzihet lehtësisht. ' +
  'Informacion mbi dietën: Produkti është i certifikuar Halal, pa gluten dhe i prodhuar nga ' +
  'produkte qumështi të ushqyera me bar.';

/** `Beta Alanine Compressed 90caps` — the SILENT class: no free text at all. 37/257 rows. */
const NO_FREETEXT = 'Beta Alanine Compressed 90caps\nAminoacide';

function rowFrom(source: string, id = 'r1'): CatalogAttributeRow {
  const [name = '', category = '', ...rest] = source.split('\n');
  const freeText = rest.join('\n').trim();
  return {
    id,
    name,
    normName: normalizeText(name),
    clauses: segmentClauses([name, category, freeText].filter(Boolean).join('\n')),
    populated: freeText.length > 0,
  };
}

function evidenceFrom(source: string): AttributeEvidence {
  const row = rowFrom(source);
  return { clauses: row.clauses, populated: row.populated, truncated: false };
}

const judge = (value: string, source: string, scope: 'product' | 'tenant' = 'product') =>
  evaluateAttributeClaim(parseAttributeClaim(value), evidenceFrom(source), scope);

// ---------------------------------------------------------------------------
// A. THE ACCEPTANCE CASE
// ---------------------------------------------------------------------------

describe('P3-1 acceptance — the roadmap\'s own example', () => {
  it('"pa sheqer" about Mega mass 3kg Vanil is CONTRADICTED by the real row', () => {
    // The row says "Sheqer i reduktuar ... më e ulët në sheqer". Reduced is not free.
    assert.equal(judge('pa sheqer', MEGA_MASS_VANIL), 'contradicted');
  });

  it('the claim is refuted, not merely unsupported — the catalog is NOT silent on sugar here', () => {
    const evidence = evidenceFrom(MEGA_MASS_VANIL);
    assert.ok(
      evidence.clauses.some((c) => c.includes('sheqer')),
      'fixture drift: the acceptance row must mention sugar, or it is a silence case not a contradiction case',
    );
  });

  it('a substance-mention rule would MISS it — this is why the predicate is phrase-level', () => {
    const folded = evidenceFrom(MEGA_MASS_VANIL).clauses.join(' ');
    // The substance IS mentioned, so any rule of the form "is this substance in the row's text?"
    // calls the fabrication grounded. Only the contiguous privative PHRASE is absent, and only
    // reading the operator around the substance ("i reduktuar", "më e ulët në") reveals that the
    // row says the opposite of the claim.
    assert.ok(containsPhrase(folded, 'sheqer'));
    assert.equal(containsPhrase(folded, 'pa sheqer'), false);
  });
});

// ---------------------------------------------------------------------------
// B. SUPPORT CORPUS — must NEVER flag
// ---------------------------------------------------------------------------

describe('support corpus (real rows) — a true claim must never be contradicted', () => {
  it('literal support: "Formula është pa sheqer" (C4 Original Bostani)', () => {
    assert.equal(judge('pa sheqer', C4_BOSTANI), 'supported');
  });

  it('COORDINATED LIST: one leading "Pa" governs sugar, dairy and lactose (Green proten)', () => {
    // Splitting the list on commas or on `ose` would sever the operator from its objects and turn
    // each into an unmarked bare mention. Asserted for both substances in the one list.
    assert.equal(judge('pa sheqer', GREEN_PROTEN), 'supported');
    assert.equal(judge('pa laktoze', GREEN_PROTEN), 'supported');
  });

  it('SUPPORT-FIRST: a row carrying BOTH signals resolves to supported (Premium EAA zero)', () => {
    // "suplement pluhur pa sheqer" AND "me sheqer të reduktuar". Without support-first ordering
    // this row — and the three others like it — are false positives.
    assert.equal(judge('pa sheqer', PREMIUM_EAA), 'supported');
  });

  it('THE BRIDGE: "pa Produkte Qumështi" supports a lactose-free claim (BEEF AMINO)', () => {
    // The same row also says "intoleranca ndaj laktozës", which a naive proximity matcher reads as
    // a contradiction. This is the single most important false-positive test in the suite.
    assert.equal(judge('pa laktoze', BEEF_AMINO), 'supported');
  });

  it('SUPPORT-FIRST on a self-contradicting real row (Isolate protein 700gr)', () => {
    // "plotësisht i ulët në ... laktozë" (would contradict) AND "Pa laktozë, pa gluten"
    // (supports). Support wins, so a claim the catalog explicitly endorses is never flagged.
    assert.equal(judge('pa laktoze', ISOLATE_PROTEIN), 'supported');
    assert.equal(judge('pa gluten', ISOLATE_PROTEIN), 'supported');
  });

  it('the bridge is ASYMMETRIC — milk may support a lactose claim but never contradict one', () => {
    // "intolerancë ndaj qumështit" is an AUDIENCE note, and milk content does not entail lactose
    // content: isolates and hydrolysates are milk-derived AND lactose-free. Asserted on a row
    // whose ONLY lactose-adjacent text is that framing.
    const audienceOnly = 'X\nY\nI tretshëm për individët me intolerancë ndaj qumështit.';
    assert.equal(judge('pa laktoze', audienceOnly), 'silent');
    assert.equal(SUPPORT_ONLY_BRIDGE.has('sheqer'), false, 'sugar must have no bridge');
  });

  it('"pa gluten" is supported from a real dietary line (Applied Nutrition whey 2kg)', () => {
    assert.equal(judge('pa gluten', APPLIED_WHEY), 'supported');
  });

  it('DIACRITICS: catalog "pa sheqër" supports a claim written "pa sheqer"', () => {
    const withDiacritic = 'X\nY\nProdukti është pa sheqër dhe pa yndyrë.';
    assert.equal(judge('pa sheqer', withDiacritic), 'supported');
  });

  it('GHEG: "ska sheqer" folds to "nuk ka sheqer" on both sides', () => {
    assert.equal(foldDialect('ska sheqer'), 'nuk ka sheqer');
    assert.equal(judge('ska sheqer', 'X\nY\nKy produkt ska sheqer fare.'), 'supported');
  });

  it('NAME-SOURCED: evidence in the product name alone is enough to support', () => {
    assert.equal(judge('pa shije', 'Pure Creatine 250gr pa shije\nKreatina\n'), 'silent');
    // 'shije' is not a lexicon substance, so the claim is ineligible → silent, never flagged.
    assert.equal(parseAttributeClaim('pa shije').eligible, false);
  });

  it('SILENCE NEVER FLAGS: a row with no free text yields silent, not contradicted', () => {
    assert.equal(judge('pa sheqer', NO_FREETEXT), 'silent');
    assert.equal(evidenceFrom(NO_FREETEXT).populated, false);
  });

  it('SILENCE NEVER FLAGS: a populated row that simply never mentions the substance', () => {
    // Mega mass talks about sugar at length but never about gluten. Note it also carries the
    // contradiction marker "përmban" — which must not fire without the substance beside it.
    assert.equal(judge('pa gluten', MEGA_MASS_VANIL), 'silent');
  });

  it('NON-ASSERTIVE FRAME alone cannot contradict', () => {
    const audienceNote = 'X\nY\nI përshtatshëm për ata me intolerancë ndaj laktozës.';
    assert.equal(judge('pa laktoze', audienceNote), 'silent');
  });

  it('TENANT SCOPE can never contradict, even against refuting text', () => {
    assert.equal(judge('pa sheqer', MEGA_MASS_VANIL, 'tenant'), 'silent');
  });

  it('TRUNCATED index makes every claim contradiction-ineligible', () => {
    const evidence = { ...evidenceFrom(MEGA_MASS_VANIL), truncated: true };
    assert.equal(evaluateAttributeClaim(parseAttributeClaim('pa sheqer'), evidence, 'product'), 'silent');
  });
});

// ---------------------------------------------------------------------------
// C. TRUE POSITIVES
// ---------------------------------------------------------------------------

describe('true positives — the catalog actively refutes the claim', () => {
  it('"ka pak sheqer" refutes "pa sheqer" (Applied Nutrition whey 2kg)', () => {
    assert.equal(judge('pa sheqer', APPLIED_WHEY), 'contradicted');
  });

  it('"i ulët në ... laktozë" refutes "pa laktozë" when the row does NOT also endorse it', () => {
    // Synthetic-by-necessity: measured live, NO row in the 257-product dev catalog contradicts a
    // lactose-free claim without also supporting it, so this coordinated-list contradiction has no
    // real exemplar to cite. Labelled rather than dressed up as a real row.
    const lowLactoseOnly =
      'X\nY\nNjë proteinë e pastër që është plotësisht i ulët në karbohidrate, yndyrë dhe laktozë.';
    assert.equal(judge('pa laktoze', lowLactoseOnly), 'contradicted');
  });

  it('English claim/evidence behaves identically', () => {
    assert.equal(judge('sugar free', 'X\nY\nThis formula contains sugar.'), 'contradicted');
    assert.equal(judge('sugar free', 'X\nY\nThis formula is sugar free.'), 'supported');
  });
});

// ---------------------------------------------------------------------------
// D. ELIGIBILITY — the primary false-positive firewall
// ---------------------------------------------------------------------------

describe('eligibility firewall — only closed-class exclusion claims can ever be judged', () => {
  for (const value of [
    'shije vanilje',
    '3kg',
    'me proteina',
    'i importuar nga gjermania',
    'me i miri',
    'ngjyra e kuqe',
    'Vanil',
  ]) {
    it(`INELIGIBLE: "${value}"`, () => {
      const claim = parseAttributeClaim(value);
      assert.equal(claim.eligible, false);
      // An ineligible claim is silent regardless of evidence, at every scope.
      assert.equal(evaluateAttributeClaim(claim, evidenceFrom(MEGA_MASS_VANIL), 'product'), 'silent');
    });
  }

  for (const value of ['pa sheqer', 'pa laktoze', 'nuk ka gluten', 'sugar free', 'pa kafeine']) {
    it(`ELIGIBLE: "${value}"`, () => {
      const claim = parseAttributeClaim(value);
      assert.equal(claim.eligible, true);
      assert.equal(claim.polarity, 'exclusion');
      assert.ok(claim.substances.length > 0);
    });
  }
});

// ---------------------------------------------------------------------------
// E. PROSE LOCATION + VERDICT FOLD
// ---------------------------------------------------------------------------

describe('locateClaimInProse', () => {
  it('returns the folded phrase when the reply actually says it', () => {
    const claim = parseAttributeClaim('pa sheqer');
    assert.equal(locateClaimInProse(claim, foldDialect('Po, është pa sheqer.')), 'pa sheqer');
  });

  it('returns null when the declared claim never reaches the customer', () => {
    const claim = parseAttributeClaim('pa sheqer');
    assert.equal(locateClaimInProse(claim, foldDialect('Çmimi është 18.00 euro.')), null);
  });

  it('returns null for an ineligible claim, so it can never strip', () => {
    assert.equal(locateClaimInProse(parseAttributeClaim('3kg'), 'mega mass 3kg'), null);
  });
});

describe('decideAttributeVerdicts — mode gating', () => {
  const claims = [
    {
      claim: parseAttributeClaim('pa sheqer'),
      productRef: 'Mega mass 3kg Vanil',
      proseSpan: 'pa sheqer',
      evidence: evidenceFrom(MEGA_MASS_VANIL),
      matchedProduct: 'Mega mass 3kg Vanil',
      scope: 'product' as const,
    },
  ];

  it('off: nothing is even computed', () => {
    assert.deepEqual(decideAttributeVerdicts({ claims, mode: 'off' }), { flagged: [], observed: [] });
  });

  it('shadow: observed but never flagged', () => {
    const out = decideAttributeVerdicts({ claims, mode: 'shadow' });
    assert.equal(out.flagged.length, 0);
    assert.equal(out.observed.length, 1);
    assert.equal(out.observed[0].support, 'contradicted');
  });

  it('enforce: flagged and observed agree, so a shadow bake-in predicts the cutover exactly', () => {
    const out = decideAttributeVerdicts({ claims, mode: 'enforce' });
    assert.deepEqual(out.flagged, out.observed);
    assert.equal(out.flagged.length, 1);
  });

  it('determinism: 20 identical runs produce an identical verdict', () => {
    const first = JSON.stringify(decideAttributeVerdicts({ claims, mode: 'enforce' }));
    for (let i = 0; i < 20; i += 1) {
      assert.equal(JSON.stringify(decideAttributeVerdicts({ claims, mode: 'enforce' })), first);
    }
  });
});

// ---------------------------------------------------------------------------
// F. INDEX PROJECTIONS + LEXICON HYGIENE
// ---------------------------------------------------------------------------

describe('evidence projections', () => {
  const index: CatalogAttributeIndex = {
    rows: [rowFrom(C4_BOSTANI, 'a'), rowFrom(MEGA_MASS_VANIL, 'b')],
    truncated: false,
  };

  it('evidenceForRow carries the index-level truncated flag forward', () => {
    const truncated = { ...index, truncated: true };
    assert.equal(evidenceForRow(index.rows[0], truncated).truncated, true);
  });

  it('an unresolved ref yields empty, unpopulated evidence', () => {
    const e = evidenceForRow(null, index);
    assert.deepEqual(e.clauses, []);
    assert.equal(e.populated, false);
  });

  it('tenantWideEvidence unions every row and can only ever rescue', () => {
    const e = tenantWideEvidence(index);
    assert.ok(e.clauses.length >= index.rows[0].clauses.length);
    // Supported tenant-wide (C4 says "pa sheqer") — and tenant scope cannot contradict anyway.
    assert.equal(evaluateAttributeClaim(parseAttributeClaim('pa sheqer'), e, 'tenant'), 'supported');
  });
});

describe('lexicon hygiene', () => {
  it('no exported entry contains a diacritic — every consumer folds first, so one would be dead', () => {
    const all = [
      ...[...SUBSTANCE_LEXICON.values()].flat(),
      ...[...SUPPORT_ONLY_BRIDGE.values()].flat(),
      ...EXCLUSION_MARKERS,
      ...CONTRADICTION_MARKERS,
      ...NON_ASSERTIVE_FRAMES,
    ];
    for (const entry of all) {
      assert.equal(
        entry,
        normalizeText(entry),
        `"${entry}" is not in folded form — it can never match and is a dead alternate (the RC-25 trap)`,
      );
    }
  });

  it('inflections are explicit, not prefix-stemmed', () => {
    const sheqer = SUBSTANCE_LEXICON.get('sheqer') ?? [];
    for (const form of ['sheqer', 'sheqeri', 'sheqerit', 'sugar']) {
      assert.ok(sheqer.includes(form), `missing explicit form "${form}"`);
    }
    const laktoze = SUBSTANCE_LEXICON.get('laktoze') ?? [];
    for (const form of ['laktoze', 'laktoza', 'laktozes', 'lactose']) {
      assert.ok(laktoze.includes(form), `missing explicit form "${form}"`);
    }
  });

  it('whole-token matching: "milk" must not match inside "milkshake"', () => {
    assert.equal(containsPhrase('banane milkshake proteina', 'milk'), false);
    assert.equal(containsPhrase('pa produkte milk sot', 'milk'), true);
  });

  it('segmentClauses runs on RAW text and preserves coordinated lists intact', () => {
    const clauses = segmentClauses('Pa sheqer, produkte qumështi, laktozë. Diçka tjetër.');
    assert.equal(clauses.length, 2);
    assert.ok(clauses[0].includes('pa sheqer'));
    // The list stays in ONE clause, so the leading "pa" still governs lactose.
    assert.ok(clauses[0].includes('laktoze'));
  });
});

// ---------------------------------------------------------------------------
// P1-B. MEMBERSHIP predicate for declared VALUE claims (the "Qershi" class).
//
// Runtime evidence (dev DB, 2026-07-22): "BSN Creatine është në shije Qershi." shipped with the
// model's own facts_used declaring {type:'attribute', value:'Qershi', product_ref:'BSN Creatine
// 216gr'} while BSN's real description says "pa aromë" (unflavored). The value was transferred
// from sibling rows ("Creatine 500gr Qershi") present in the same retrieval window.
// ---------------------------------------------------------------------------

/** BSN Creatine 216gr — real description shape: explicitly UNFLAVORED. */
const BSN_CREATINE =
  'BSN Creatine 216gr\nKreatina\n' +
  'Pluhur kreatine lehtësisht i tretshëm dhe pa aromë, mund ta kombinoni me pluhura proteinash.';

/** Flavor lives only in the NAME — the dominant real-catalog shape (78/257 names). */
const CREATINE_QERSHI = 'Creatine 500gr Qershi\nKreatina';

const judgeValue = (value: string, source: string, scope: 'product' | 'tenant' = 'product') =>
  evaluateValueClaimMembership(parseAttributeClaim(value), evidenceFrom(source), scope);

describe('parseAttributeClaim — claim kinds (P1-B)', () => {
  it('an exclusion claim keeps kind exclusion and stays out of the membership lane', () => {
    const claim = parseAttributeClaim('pa sheqer');
    assert.equal(claim.kind, 'exclusion');
    assert.equal(claim.eligible, true);
    assert.equal(claim.membershipEligible, false);
  });

  it('a concrete value claim is kind value and membership-eligible', () => {
    for (const v of ['Qershi', 'shije vanilje', '1kg', '216gr']) {
      const claim = parseAttributeClaim(v);
      assert.equal(claim.kind, 'value', v);
      assert.equal(claim.eligible, false, v);
      assert.equal(claim.membershipEligible, true, v);
    }
  });

  it('letterless or too-short values are not membership-eligible (mistyped prices, fragments)', () => {
    for (const v of ['18.00', '0', 'ok', '  ']) {
      assert.equal(parseAttributeClaim(v).membershipEligible, false, v);
    }
  });
});

describe('locateValueClaimInProse', () => {
  it('locates a value the reply actually states', () => {
    const claim = parseAttributeClaim('Qershi');
    assert.equal(locateValueClaimInProse(claim, foldDialect('BSN Creatine është në shije Qershi.')), 'qershi');
  });

  it('returns null when the reply never says the value — null can never strip', () => {
    const claim = parseAttributeClaim('Qershi');
    assert.equal(locateValueClaimInProse(claim, foldDialect('Çmimi është 25 euro.')), null);
  });

  it('never locates an exclusion claim (that lane has its own locator)', () => {
    const claim = parseAttributeClaim('pa sheqer');
    assert.equal(locateValueClaimInProse(claim, foldDialect('Ky produkt është pa sheqer.')), null);
  });
});

describe('evaluateValueClaimMembership', () => {
  it('ABSENT: "Qershi" against the real BSN row — the acceptance fabrication', () => {
    assert.equal(judgeValue('Qershi', BSN_CREATINE), 'absent');
  });

  it('SUPPORTED: the referenced row grounds the value from its NAME alone', () => {
    assert.equal(judgeValue('Qershi', CREATINE_QERSHI), 'supported');
  });

  it('SUPPORTED: description grounds an unflavored value ("pa aromë")', () => {
    assert.equal(judgeValue('pa aromë', BSN_CREATINE), 'supported');
  });

  it('SUPPORTED: dialect variants bridge spelling families (çokollatë vs Qokolad)', () => {
    const row = 'Take a Whey 1kg Qokolad\nProteina';
    assert.equal(judgeValue('çokollatë', row), 'supported');
  });

  it('SILENT at tenant scope — an unresolved ref can never flag', () => {
    assert.equal(judgeValue('Qershi', BSN_CREATINE, 'tenant'), 'silent');
  });

  it('SILENT on a truncated index — a partial view can never flag', () => {
    const evidence = { ...evidenceFrom(BSN_CREATINE), truncated: true };
    assert.equal(evaluateValueClaimMembership(parseAttributeClaim('Qershi'), evidence, 'product'), 'silent');
  });

  it('SILENT for claims that are not membership-eligible', () => {
    assert.equal(judgeValue('18.00', BSN_CREATINE), 'silent');
  });
});

describe('decideAttributeVerdicts — membership routing (P1-B)', () => {
  const absentClaim = {
    claim: parseAttributeClaim('Qershi'),
    productRef: 'BSN Creatine 216gr',
    proseSpan: 'qershi',
    evidence: evidenceFrom(BSN_CREATINE),
    matchedProduct: 'BSN Creatine 216gr',
    scope: 'product' as const,
  };

  it('shadow observes an absent value without flagging', () => {
    const { flagged, observed } = decideAttributeVerdicts({ claims: [absentClaim], mode: 'shadow' });
    assert.equal(flagged.length, 0);
    assert.equal(observed.length, 1);
    assert.equal(observed[0].support, 'absent');
    assert.equal(observed[0].value, 'Qershi');
  });

  it('enforce flags the same computation shadow observed', () => {
    const { flagged, observed } = decideAttributeVerdicts({ claims: [absentClaim], mode: 'enforce' });
    assert.deepEqual(flagged, observed);
    assert.equal(flagged[0].support, 'absent');
  });

  it('a supported value claim is never observed', () => {
    const supportedClaim = { ...absentClaim, evidence: evidenceFrom(CREATINE_QERSHI) };
    const { flagged, observed } = decideAttributeVerdicts({ claims: [supportedClaim], mode: 'enforce' });
    assert.equal(flagged.length, 0);
    assert.equal(observed.length, 0);
  });
});
