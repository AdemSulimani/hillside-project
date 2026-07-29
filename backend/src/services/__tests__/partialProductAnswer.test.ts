/**
 * Tests for the PARTIAL PRODUCT ANSWER + attribute-level escalation feature.
 *
 * These cover the pure, import-safe decision logic that drives the new behaviour in
 * processAIReply.ts:
 *
 *   - When a customer asks several things and we know SOME but not all, we answer
 *     what we know AND escalate only the missing parts (partial answer).
 *   - When a product IS identified but a requested attribute cannot be found, we send
 *     a "we will notify you shortly" notice — never "the product is not available".
 *   - When everything is known we send the full answer with no escalation.
 *
 * All tests run in-process with no network/DB/OpenAI calls — the live LLM composer
 * (assessProductInformationRequest) is exercised separately via its grounded prompt;
 * here we feed representative assessment outputs into the deterministic combiners.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMissingInfoHoldingMessage,
  buildMissingInfoNotice,
  composePartialAnswer,
  computeMissingStructuredAttributes,
  dedupeInfoLabels,
  deriveAnswerabilityStatus,
  formatInfoList,
  localizedAttributeLabels,
  reconcileMissingAgainstAnswer,
  stripContradictoryMissingInfoNotice,
  type AnswerabilityStatus,
  type StructuredAttributeMap,
} from '../productInformationGapHelpers';

// ---------------------------------------------------------------------------
// computeMissingStructuredAttributes — deterministic missing-attribute net
// ---------------------------------------------------------------------------

describe('computeMissingStructuredAttributes', () => {
  it('reports a requested attribute missing when no product carries it (Scenario 3: brand)', () => {
    const products: StructuredAttributeMap[] = [{ brand: null, flavor: 'Chocolate' }];
    assert.deepEqual(computeMissingStructuredAttributes(['brand'], products), ['brand']);
  });

  it('does NOT report an attribute that a product carries in the catalog', () => {
    const products: StructuredAttributeMap[] = [{ brand: 'Optimum Nutrition' }];
    assert.deepEqual(computeMissingStructuredAttributes(['brand'], products), []);
  });

  it('splits a multi-attribute request into answerable vs missing (Scenario 1: price+brand → brand missing)', () => {
    // price is not a structured attribute key; brand missing, flavor present.
    const products: StructuredAttributeMap[] = [{ brand: null, flavor: 'Vanilla' }];
    assert.deepEqual(computeMissingStructuredAttributes(['brand', 'flavor'], products), ['brand']);
  });

  it('treats an attribute as available when ANY of several matched products has it', () => {
    const products: StructuredAttributeMap[] = [{ brand: null }, { brand: 'Acme' }];
    assert.deepEqual(computeMissingStructuredAttributes(['brand'], products), []);
  });

  it('treats a high-confidence packaging-read attribute as available (no escalation)', () => {
    const products: StructuredAttributeMap[] = [{ brand: null }];
    const imageUsableKeys = new Set(['brand']);
    assert.deepEqual(computeMissingStructuredAttributes(['brand'], products, imageUsableKeys), []);
  });

  it('ignores empty/whitespace catalog values', () => {
    const products: StructuredAttributeMap[] = [{ brand: '   ' }];
    assert.deepEqual(computeMissingStructuredAttributes(['brand'], products), ['brand']);
  });

  it('returns [] when nothing was requested', () => {
    assert.deepEqual(computeMissingStructuredAttributes([], [{ brand: null }]), []);
  });

  it('reports every missing attribute when all are absent', () => {
    const products: StructuredAttributeMap[] = [{}];
    assert.deepEqual(
      computeMissingStructuredAttributes(['brand', 'color', 'weight'], products).sort(),
      ['brand', 'color', 'weight'],
    );
  });
});

// ---------------------------------------------------------------------------
// reconcileMissingAgainstAnswer (Layer 2) — never escalate an attribute the
// grounded answer already provides.
// ---------------------------------------------------------------------------

describe('reconcileMissingAgainstAnswer', () => {
  it('drops a flavor label when the answer already states the flavor (sq)', () => {
    assert.deepEqual(
      reconcileMissingAgainstAnswer(['shija'], 'E kemi Carbo One 1kg me shije limon.'),
      [],
    );
  });

  it('drops a flavor label when the answer states the flavor (en)', () => {
    assert.deepEqual(
      reconcileMissingAgainstAnswer(['flavor'], 'We have Carbo One 1kg in lemon flavor.'),
      [],
    );
  });

  it('matches concepts across locales/synonyms (answer in sq, label in en)', () => {
    assert.deepEqual(
      reconcileMissingAgainstAnswer(['flavor'], 'E kemi me shije limon.'),
      [],
    );
  });

  it('keeps a label whose concept is NOT in the answer', () => {
    assert.deepEqual(
      reconcileMissingAgainstAnswer(['marka'], 'Çmimi është €20.'),
      ['marka'],
    );
  });

  it('keeps only the genuinely missing labels in a multi-attribute request', () => {
    // Answer states flavor but not brand → only brand survives.
    assert.deepEqual(
      reconcileMissingAgainstAnswer(['shija', 'marka'], 'Ka shije çokollatë.'),
      ['marka'],
    );
  });

  it('matches inflected forms (shije → shijet)', () => {
    assert.deepEqual(reconcileMissingAgainstAnswer(['shija'], 'Shijet janë limon.'), []);
  });

  it('recognizes an "unflavored" answer as stating the flavor concept (pa aromë)', () => {
    // Alerts a5e280a5/a3e8376d: the correct answer "Ky pluhur kreatine është pa aromë."
    // still escalated "shija" because "arome" did not prefix-match the old 'aroma'
    // synonym token — the exact self-contradiction class this layer exists to stop.
    assert.deepEqual(
      reconcileMissingAgainstAnswer(['shija'], 'Ky pluhur kreatine është pa aromë.'),
      [],
    );
  });

  it('returns all labels unchanged when the answer is empty (none case)', () => {
    assert.deepEqual(reconcileMissingAgainstAnswer(['marka', 'shija'], ''), ['marka', 'shija']);
  });
});

// ---------------------------------------------------------------------------
// stripContradictoryMissingInfoNotice (Layer 3) — final validation pass that
// removes a "we'll notify you" notice contradicted by info already in the reply.
// ---------------------------------------------------------------------------

describe('stripContradictoryMissingInfoNotice', () => {
  it('removes the notice when the flavor is already stated (sq) — Issue #1 reproduction', () => {
    const contradictory =
      "E kemi Carbo One 1kg me shije limon. Do t'ju njoftojmë së shpejti lidhur me shije.";
    assert.equal(
      stripContradictoryMissingInfoNotice(contradictory, 'sq'),
      'E kemi Carbo One 1kg me shije limon.',
    );
  });

  it('removes the notice when the flavor is already stated (en)', () => {
    const contradictory =
      'We have Carbo One 1kg in lemon flavor. We will notify you shortly regarding the flavor information.';
    assert.equal(
      stripContradictoryMissingInfoNotice(contradictory, 'en'),
      'We have Carbo One 1kg in lemon flavor.',
    );
  });

  it('keeps a genuinely-missing notice untouched (no contradiction)', () => {
    const legit = 'The price is €20. We will notify you shortly regarding the brand information.';
    assert.equal(stripContradictoryMissingInfoNotice(legit, 'en'), legit);
  });

  it('rebuilds the notice to keep only the still-missing attribute (en)', () => {
    // Reply states the flavor but promises flavor AND brand → keep brand only.
    const mixed =
      'The chocolate flavor is available. We will notify you shortly regarding the flavor and brand information.';
    assert.equal(
      stripContradictoryMissingInfoNotice(mixed, 'en'),
      'The chocolate flavor is available. We will notify you shortly regarding the brand information.',
    );
  });

  it('leaves the generic (no named attribute) notice untouched (en)', () => {
    const generic = 'The chocolate flavor is available. We will notify you shortly regarding this information.';
    assert.equal(stripContradictoryMissingInfoNotice(generic, 'en'), generic);
  });

  it('leaves the generic notice untouched (sq)', () => {
    const generic = "Ka shije limon. Do t'ju njoftojmë së shpejti lidhur me këtë informacion.";
    assert.equal(stripContradictoryMissingInfoNotice(generic, 'sq'), generic);
  });

  it('is a no-op for replies with no notice', () => {
    const plain = 'The price is €20 and the flavor is chocolate.';
    assert.equal(stripContradictoryMissingInfoNotice(plain, 'en'), plain);
  });

  it('does not alter a standalone holding message (nothing answered to contradict)', () => {
    const holding = 'Hello, we will notify you shortly regarding the brand information.';
    assert.equal(stripContradictoryMissingInfoNotice(holding, 'en'), holding);
  });
});

// ---------------------------------------------------------------------------
// deriveAnswerabilityStatus — complete / partial / none
// ---------------------------------------------------------------------------

describe('deriveAnswerabilityStatus', () => {
  const cases: Array<[string, string, string[], AnswerabilityStatus]> = [
    ['complete when nothing missing', 'The price is €20.', [], 'complete'],
    ['partial when answer present and something missing', 'The price is €20.', ['brand'], 'partial'],
    ['none when nothing answerable and something missing', '', ['brand'], 'none'],
    ['none when answer is only whitespace', '   ', ['ingredients'], 'none'],
    ['complete even with whitespace-only missing labels', 'Answer.', ['  '], 'complete'],
  ];

  for (const [label, answer, missing, expected] of cases) {
    it(label, () => {
      assert.equal(deriveAnswerabilityStatus(answer, missing), expected);
    });
  }
});

// ---------------------------------------------------------------------------
// formatInfoList — locale-aware natural list joining
// ---------------------------------------------------------------------------

describe('formatInfoList', () => {
  it('returns a single label unchanged', () => {
    assert.equal(formatInfoList(['brand'], 'en'), 'brand');
  });
  it('joins two labels with "and" (en)', () => {
    assert.equal(formatInfoList(['brand', 'ingredients'], 'en'), 'brand and ingredients');
  });
  it('joins three labels with commas + "and" (en)', () => {
    assert.equal(formatInfoList(['a', 'b', 'c'], 'en'), 'a, b and c');
  });
  it('joins with "dhe" (sq)', () => {
    assert.equal(formatInfoList(['marka', 'pesha'], 'sq'), 'marka dhe pesha');
  });
  it('returns empty string for an empty list', () => {
    assert.equal(formatInfoList([], 'en'), '');
  });
});

// ---------------------------------------------------------------------------
// dedupeInfoLabels — cross-casing / diacritic / phrasing de-duplication
// ---------------------------------------------------------------------------

describe('dedupeInfoLabels', () => {
  it('drops case-insensitive duplicates, keeping the first form', () => {
    assert.deepEqual(dedupeInfoLabels(['Brand', 'brand']), ['Brand']);
  });
  it('treats "the brand information" the same as "brand"', () => {
    assert.deepEqual(dedupeInfoLabels(['brand', 'the brand information']), ['brand']);
  });
  it('strips diacritics for comparison (Albanian)', () => {
    assert.deepEqual(dedupeInfoLabels(['përbërësit', 'perberesit']), ['përbërësit']);
  });
  it('removes empty/whitespace labels', () => {
    assert.deepEqual(dedupeInfoLabels(['brand', '', '   ']), ['brand']);
  });
  it('collapses brand synonyms ("brandi"/"marka") to the canonical label', () => {
    assert.deepEqual(dedupeInfoLabels(['brandi', 'marka']), ['marka']);
  });
  it('collapses English brand synonyms ("trademark"/"brand")', () => {
    assert.deepEqual(dedupeInfoLabels(['trademark', 'brand']), ['brand']);
  });
  it('collapses flavor synonyms ("aroma"/"shija")', () => {
    assert.deepEqual(dedupeInfoLabels(['aroma', 'shija']), ['shija']);
  });
  it('collapses weight synonyms ("masa"/"pesha")', () => {
    assert.deepEqual(dedupeInfoLabels(['masa', 'pesha']), ['pesha']);
  });
  it('keeps the first synonym when none is canonical', () => {
    assert.deepEqual(dedupeInfoLabels(['brandi', 'trademark']), ['brandi']);
  });
  it('does NOT collapse distinct attributes (brand vs weight)', () => {
    assert.deepEqual(dedupeInfoLabels(['marka', 'pesha']), ['marka', 'pesha']);
  });
  it('keeps free-form labels that are not in any synonym group', () => {
    assert.deepEqual(dedupeInfoLabels(['marka', 'përbërësit']), ['marka', 'përbërësit']);
  });
});

// ---------------------------------------------------------------------------
// Issue #4 regression: a single requested attribute is named once even when the
// LLM label and the deterministic structured label are synonyms.
// ---------------------------------------------------------------------------

describe('buildMissingInfoNotice synonym collapsing', () => {
  it('mentions the brand attribute only once (sq)', () => {
    // Merge order mirrors processAIReply: LLM label first, structured label second.
    const merged = dedupeInfoLabels(['brandi', ...localizedAttributeLabels(['brand'], 'sq')]);
    assert.deepEqual(merged, ['marka']);
    assert.equal(
      buildMissingInfoNotice(merged, 'sq'),
      "Do t'ju njoftojmë së shpejti lidhur me marka.",
    );
  });
  it('mentions the brand attribute only once (en)', () => {
    const merged = dedupeInfoLabels(['trademark', ...localizedAttributeLabels(['brand'], 'en')]);
    assert.deepEqual(merged, ['brand']);
    assert.equal(
      buildMissingInfoNotice(merged, 'en'),
      'We will notify you shortly regarding the brand information.',
    );
  });
});

// ---------------------------------------------------------------------------
// localizedAttributeLabels
// ---------------------------------------------------------------------------

describe('localizedAttributeLabels', () => {
  it('maps keys to English labels', () => {
    assert.deepEqual(localizedAttributeLabels(['brand', 'category'], 'en'), ['brand', 'product type']);
  });
  it('maps keys to Albanian labels', () => {
    assert.deepEqual(localizedAttributeLabels(['brand', 'weight'], 'sq'), ['marka', 'pesha']);
  });
});

// ---------------------------------------------------------------------------
// buildMissingInfoNotice / buildMissingInfoHoldingMessage
// ---------------------------------------------------------------------------

describe('buildMissingInfoNotice', () => {
  it('names the missing info (en)', () => {
    assert.equal(
      buildMissingInfoNotice(['brand'], 'en'),
      'We will notify you shortly regarding the brand information.',
    );
  });
  it('names the missing info (sq)', () => {
    assert.equal(
      buildMissingInfoNotice(['marka'], 'sq'),
      "Do t'ju njoftojmë së shpejti lidhur me marka.",
    );
  });
  it('falls back to a generic notice with no labels (en)', () => {
    assert.equal(
      buildMissingInfoNotice([], 'en'),
      'We will notify you shortly regarding this information.',
    );
  });

  it('NEVER implies the product is unavailable / not in catalog', () => {
    const forbidden = ['not available', 'not in our catalog', 'does not exist', 'nuk e kemi', 'nuk ekziston'];
    for (const locale of ['en', 'sq'] as const) {
      const text = buildMissingInfoNotice(['brand', 'ingredients'], locale).toLowerCase();
      for (const phrase of forbidden) {
        assert.ok(!text.includes(phrase), `notice must not contain "${phrase}" (${locale})`);
      }
    }
  });
});

describe('buildMissingInfoHoldingMessage', () => {
  it('greets and names the missing info (en) — Scenario 2: ingredients', () => {
    assert.equal(
      buildMissingInfoHoldingMessage(['ingredients'], 'en'),
      'Hello, we will notify you shortly regarding the ingredients information.',
    );
  });
  it('greets and names the missing info (sq) — Scenario 3: brand', () => {
    assert.equal(
      buildMissingInfoHoldingMessage(['marka'], 'sq'),
      "Përshëndetje, do t'ju njoftojmë së shpejti lidhur me marka.",
    );
  });
});

// ---------------------------------------------------------------------------
// composePartialAnswer — known info + notice for the rest
// ---------------------------------------------------------------------------

describe('composePartialAnswer', () => {
  it('matches the Scenario 1 expected response exactly', () => {
    assert.equal(
      composePartialAnswer('The price is €20.', ['brand'], 'en'),
      'The price is €20. We will notify you shortly regarding the brand information.',
    );
  });

  it('inserts ". " when the known answer lacks terminal punctuation', () => {
    assert.equal(
      composePartialAnswer('The price is €20', ['brand'], 'en'),
      'The price is €20. We will notify you shortly regarding the brand information.',
    );
  });

  it('produces just the notice when there is no known answer', () => {
    assert.equal(
      composePartialAnswer('', ['brand'], 'en'),
      'We will notify you shortly regarding the brand information.',
    );
  });

  it('composes a multi-missing partial answer (sq)', () => {
    assert.equal(
      composePartialAnswer('Çmimi është €20.', ['marka', 'pesha'], 'sq'),
      "Çmimi është €20. Do t'ju njoftojmë së shpejti lidhur me marka dhe pesha.",
    );
  });

  it('never implies the product is unavailable even when nothing is known', () => {
    const text = composePartialAnswer('', ['brand', 'ingredients'], 'en').toLowerCase();
    assert.ok(!text.includes('not available'));
    assert.ok(!text.includes('does not exist'));
  });
});

// ---------------------------------------------------------------------------
// End-to-end scenario combiner — mirrors the processAIReply decision flow using
// the same helpers, so the documented behaviour is regression-tested without
// importing the OpenAI-dependent job module.
// ---------------------------------------------------------------------------

interface ScenarioInput {
  /** What the LLM composer would return: grounded answer + missing labels. */
  assessment: { answer: string; missing: string[] };
  /** Requested structured attribute keys + matched product structured maps. */
  requested: Parameters<typeof computeMissingStructuredAttributes>[0];
  products: StructuredAttributeMap[];
  imageUsableKeys?: Set<string>;
  locale: 'en' | 'sq';
}

function decideOutcome(input: ScenarioInput): {
  status: AnswerabilityStatus;
  reply: string | null; // null = keep original AI reply (no escalation)
  escalated: boolean;
  missing: string[];
} {
  const deterministicMissing = computeMissingStructuredAttributes(
    input.requested,
    input.products,
    input.imageUsableKeys ?? new Set(),
  );
  const merged = reconcileMissingAgainstAnswer(
    dedupeInfoLabels([
      ...input.assessment.missing,
      ...localizedAttributeLabels(deterministicMissing, input.locale),
    ]),
    input.assessment.answer,
  );
  const status = deriveAnswerabilityStatus(input.assessment.answer, merged);
  if (status === 'complete') {
    return { status, reply: null, escalated: false, missing: [] };
  }
  const reply =
    status === 'partial'
      ? composePartialAnswer(input.assessment.answer, merged, input.locale)
      : buildMissingInfoHoldingMessage(merged, input.locale);
  return { status, reply, escalated: true, missing: merged };
}

describe('partial-answer scenario combiner', () => {
  it('Scenario 1: price found, brand missing → partial answer + escalation', () => {
    const outcome = decideOutcome({
      assessment: { answer: 'The price is €20.', missing: ['brand'] },
      requested: ['brand'],
      products: [{ brand: null }],
      locale: 'en',
    });
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.escalated, true);
    assert.equal(
      outcome.reply,
      'The price is €20. We will notify you shortly regarding the brand information.',
    );
    assert.deepEqual(outcome.missing, ['brand']);
  });

  it('Scenario 2: ingredients not found (free-form) → holding notice + escalation', () => {
    const outcome = decideOutcome({
      assessment: { answer: '', missing: ['ingredients'] },
      requested: [], // ingredients is not a structured attribute
      products: [{ brand: 'Acme' }],
      locale: 'en',
    });
    assert.equal(outcome.status, 'none');
    assert.equal(outcome.escalated, true);
    assert.equal(
      outcome.reply,
      'Hello, we will notify you shortly regarding the ingredients information.',
    );
  });

  it('Scenario 3: brand not found → holding notice (NOT "product not available")', () => {
    const outcome = decideOutcome({
      assessment: { answer: '', missing: ['brand'] },
      requested: ['brand'],
      products: [{ brand: null, flavor: 'Vanilla' }],
      locale: 'en',
    });
    assert.equal(outcome.status, 'none');
    assert.equal(outcome.escalated, true);
    assert.ok(outcome.reply);
    const lower = (outcome.reply as string).toLowerCase();
    assert.ok(!lower.includes('not available'));
    assert.ok(!lower.includes('not in our catalog'));
    assert.ok(!lower.includes('does not exist'));
  });

  it('everything known → no escalation, keep the original AI reply', () => {
    const outcome = decideOutcome({
      assessment: { answer: 'The price is €20 and the brand is Acme.', missing: [] },
      requested: ['brand'],
      products: [{ brand: 'Acme' }],
      locale: 'en',
    });
    assert.equal(outcome.status, 'complete');
    assert.equal(outcome.escalated, false);
    assert.equal(outcome.reply, null);
  });

  it('deterministic net escalates a missing attribute even if the LLM said nothing is missing', () => {
    // LLM lenient (missing=[]) but catalog truly lacks brand → still escalate.
    const outcome = decideOutcome({
      assessment: { answer: 'The price is €20.', missing: [] },
      requested: ['brand'],
      products: [{ brand: null }],
      locale: 'en',
    });
    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.escalated, true);
    assert.deepEqual(outcome.missing, ['brand']);
  });

  it('packaging-read attribute keeps the answer complete (no false escalation)', () => {
    const outcome = decideOutcome({
      assessment: { answer: 'The brand is Optimum Nutrition (read from the packaging).', missing: [] },
      requested: ['brand'],
      products: [{ brand: null }],
      imageUsableKeys: new Set(['brand']),
      locale: 'en',
    });
    assert.equal(outcome.status, 'complete');
    assert.equal(outcome.escalated, false);
  });

  it('does not duplicate a missing label reported by both the LLM and the deterministic net', () => {
    const outcome = decideOutcome({
      assessment: { answer: 'The price is €20.', missing: ['brand'] },
      requested: ['brand'],
      products: [{ brand: null }],
      locale: 'en',
    });
    assert.deepEqual(outcome.missing, ['brand']);
  });

  it('Issue #1 regression: flavor in the product name → complete answer, NO contradictory notice (sq)', () => {
    // Mirrors "Carbo One 1kg me shije limon": structured flavor column is empty but the
    // text-aware resolver (Layer 1) supplies flavor="limon", and the grounded answer
    // states it — so the request is fully answerable with no "we'll notify you" notice.
    const outcome = decideOutcome({
      assessment: { answer: 'E kemi Carbo One 1kg me shije limon.', missing: [] },
      requested: ['flavor'],
      // What getProductInferredAttributes(product) returns for the matched SKU.
      products: [{ flavor: 'limon' }],
      locale: 'sq',
    });
    assert.equal(outcome.status, 'complete');
    assert.equal(outcome.escalated, false);
    assert.equal(outcome.reply, null);
  });

  it('Issue #1 belt-and-suspenders: even if the net flags flavor, reconciliation drops it', () => {
    // Simulate Layer 1 failing (flavor column empty AND not inferred) but the grounded
    // answer still stating the flavor. Layer 2 reconciliation must remove it so the
    // reply is never self-contradictory.
    const outcome = decideOutcome({
      assessment: { answer: 'E kemi me shije limon.', missing: [] },
      requested: ['flavor'],
      products: [{ flavor: null }], // net would flag flavor missing
      locale: 'sq',
    });
    assert.equal(outcome.status, 'complete');
    assert.equal(outcome.escalated, false);
  });
});
