/**
 * Tests for the deterministic-first product-information gap gate (P0-3, RC-01).
 *
 * RC-01: `assessProductInformationRequest` is the pipeline's only fail-CLOSED guard —
 * on transport/parse/empty failure it returns ok:false and the caller escalates, and
 * its English-prompted stochastic `missing` labels over Albanian text escalate plain
 * answerable questions (live replay: IN1 8/8 with missing=['marka'] though brand was
 * never asked; IN3 8/8 with a non-deterministic question-echo missing-set at temp 0;
 * EV-010 emitted ['ma shum']).
 *
 * Under GAP_GATE_DETERMINISTIC_FIRST the gate must:
 *  - escalate ONLY on deterministic evidence: a requested structured attribute absent
 *    from every signal, a per-product gap in multi-product questions, or an
 *    allowlisted FREE-FORM info gap (ingredients, usage, …);
 *  - never escalate purely on the LLM's `missing` labels or its `!ok`;
 *  - fail OPEN when the assessor ERRORED and the deterministic net is clear (the
 *    grounded AI reply is sent as-is), while a true structured gap still escalates
 *    even on assessor error.
 *
 * Golden-set determinism assertion (RC-01 regression prevention, permanent CI
 * fixture): answerable IN1/IN3-seeded inputs are replayed against N≥20 adversarial
 * simulated assessor outputs each — the decision must be "send as-is" on every run.
 *
 * All tests are pure/in-process (no network/DB/OpenAI): they exercise the same
 * helpers processAIReply.ts composes, mirroring partialProductAnswer.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMissingInfoHoldingMessage,
  composePartialAnswer,
  computeMissingStructuredAttributes,
  decideGapEscalation,
  dedupeInfoLabels,
  deriveAnswerabilityStatus,
  filterFreeFormInfoLabels,
  localizedAttributeLabels,
  reconcileMissingAgainstAnswer,
  type AnswerabilityStatus,
  type InfoGapLocale,
  type StructuredAttributeMap,
} from '../productInformationGapHelpers';
import type { StructuredAttributeKey } from '../productRetrievalService';

// ---------------------------------------------------------------------------
// filterFreeFormInfoLabels — the narrowly-scoped free-form allowlist
// ---------------------------------------------------------------------------

describe('filterFreeFormInfoLabels', () => {
  it('keeps known free-form info labels in both locales (incl. informal/inflected)', () => {
    const kept = [
      'ingredients',
      'përbërësit',
      'perberesit',
      'usage',
      'përdorimi',
      'doza',
      'dozimi',
      'afati i skadencës',
      'expiry date',
      'vlerat ushqyese',
      'nutritional values',
      'gluten',
      'garancia',
      'origjina',
    ];
    assert.deepEqual(filterFreeFormInfoLabels(kept), kept);
  });

  it('drops structured-attribute synonyms — the deterministic net owns those', () => {
    assert.deepEqual(
      filterFreeFormInfoLabels(['marka', 'brandi', 'brand', 'shija', 'ngjyra', 'pesha', 'madhesia', 'varianti']),
      [],
    );
  });

  it('suppresses the measured stochastic question-echo labels (IN1/IN3/EV-010)', () => {
    assert.deepEqual(
      filterFreeFormInfoLabels(['marka', 'cila eshte me e mire', 'më e mirë', 'ma shum']),
      [],
    );
  });

  it('suppresses bare product-category nutrition echoes for supplement catalogs', () => {
    // In a supplements niche "protein" is the product category, not a nutrition-info
    // request: an LLM echo like "proteina" on an answerable question must not survive
    // the filter (it would reintroduce the RC-01 false-escalation class). Only
    // content/quantity-shaped labels count as genuine nutrition gaps.
    assert.deepEqual(
      filterFreeFormInfoLabels(['proteina', 'protein', 'kalori', 'kaloritë', 'calories']),
      [],
    );
  });

  it('keeps content/quantity-shaped nutrition labels (genuine free-form gaps)', () => {
    const kept = ['sa proteina ka', 'protein content per serving', 'sa kalori ka nje doze'];
    assert.deepEqual(filterFreeFormInfoLabels(kept), kept);
  });

  it('drops empty/whitespace/non-string junk', () => {
    assert.deepEqual(filterFreeFormInfoLabels(['', '   ', null as unknown as string]), []);
  });

  it('keeps only the allowlisted entries of a mixed list, preserving order', () => {
    assert.deepEqual(
      filterFreeFormInfoLabels(['marka', 'përbërësit', 'ma shum', 'usage']),
      ['përbërësit', 'usage'],
    );
  });
});

// ---------------------------------------------------------------------------
// decideGapEscalation — legacy vs deterministic-first policy
// ---------------------------------------------------------------------------

describe('decideGapEscalation', () => {
  it('legacy: !ok escalates even when status is complete (fail-closed preserved)', () => {
    assert.equal(decideGapEscalation({ ok: false }, 'complete', false), true);
  });

  it('legacy: ok + complete → no escalation; ok + partial/none → escalation', () => {
    assert.equal(decideGapEscalation({ ok: true }, 'complete', false), false);
    assert.equal(decideGapEscalation({ ok: true }, 'partial', false), true);
    assert.equal(decideGapEscalation({ ok: true }, 'none', false), true);
  });

  it('deterministic-first: complete never escalates, regardless of ok (fail-open)', () => {
    assert.equal(decideGapEscalation({ ok: false }, 'complete', true), false);
    assert.equal(decideGapEscalation({ ok: true }, 'complete', true), false);
  });

  it('deterministic-first: deterministically-backed partial/none still escalates', () => {
    assert.equal(decideGapEscalation({ ok: false }, 'none', true), true);
    assert.equal(decideGapEscalation({ ok: true }, 'partial', true), true);
  });
});

// ---------------------------------------------------------------------------
// Deterministic-first scenario combiner — mirrors the flag-ON decision flow in
// processAIReply.ts (filter → deterministic net → per-product pass → merge →
// status → decideGapEscalation) using the same helpers, without importing the
// OpenAI-dependent job module.
// ---------------------------------------------------------------------------

interface Assessment {
  answer: string;
  missing: string[];
  ok: boolean;
  errored: boolean;
}

interface ScenarioInput {
  assessment: Assessment;
  requested: StructuredAttributeKey[];
  products: StructuredAttributeMap[];
  imageUsableKeys?: Set<string>;
  locale: InfoGapLocale;
}

function decideOutcomeDeterministicFirst(input: ScenarioInput): {
  status: AnswerabilityStatus;
  reply: string | null; // null = original AI reply sent as-is (no escalation)
  escalated: boolean;
  missing: string[];
} {
  const deterministicMissing = computeMissingStructuredAttributes(
    input.requested,
    input.products,
    input.imageUsableKeys ?? new Set(),
  );
  const llmMissing = filterFreeFormInfoLabels(input.assessment.missing);
  const merged = reconcileMissingAgainstAnswer(
    dedupeInfoLabels([
      ...llmMissing,
      ...localizedAttributeLabels(deterministicMissing, input.locale),
    ]),
    input.assessment.answer,
  );
  // Per-product pass (multi-product questions): an attribute present for SOME
  // matched products but absent for others escalates, bypassing reconciliation.
  const perProduct: string[] = [];
  if (input.products.length > 1) {
    for (const key of input.requested) {
      if (deterministicMissing.includes(key)) continue;
      const anyMissing = input.products.some((p) => {
        const val = p?.[key];
        return !(typeof val === 'string' && val.trim().length > 0);
      });
      if (anyMissing) perProduct.push(...localizedAttributeLabels([key], input.locale));
    }
  }
  const finalMissing = dedupeInfoLabels([...merged, ...perProduct]);
  const status = deriveAnswerabilityStatus(input.assessment.answer, finalMissing);
  if (!decideGapEscalation(input.assessment, status, true)) {
    return { status, reply: null, escalated: false, missing: [] };
  }
  const reply =
    status === 'partial'
      ? composePartialAnswer(input.assessment.answer, finalMissing, input.locale)
      : buildMissingInfoHoldingMessage(finalMissing, input.locale);
  return { status, reply, escalated: true, missing: finalMissing };
}

// Answerable golden inputs, seeded from the live-replay corpus. Brand is null on
// every row (as in IN1) but was never asked — availability/attribute questions the
// catalog can answer must never escalate.
const GOLDEN_ANSWERABLE: Array<{ name: string; input: Omit<ScenarioInput, 'assessment'> }> = [
  {
    // IN1: "A e keni Carbo One?" — plain availability, no structured attribute asked.
    name: 'IN1 availability question (assessor echoed ["marka"] 8/8)',
    input: {
      requested: [],
      products: [
        { brand: null, flavor: 'Limon', weight: '1kg' },
        { brand: null, flavor: 'Portokall', weight: '1kg' },
      ],
      locale: 'sq',
    },
  },
  {
    // IN3: comparison-flavoured question that reaches the assessor; echo labels vary
    // per run at temp 0 (["cila eshte me e mire"] / ["më e mirë"]).
    name: 'IN3 which-is-better question (non-deterministic echo missing-set)',
    input: {
      requested: [],
      products: [
        { brand: null, flavor: 'Çokollatë' },
        { brand: null, flavor: 'Vanilje' },
      ],
      locale: 'sq',
    },
  },
  {
    // Requested attribute IS present in the catalog — deterministic net is clear.
    name: 'flavor question answerable from structured fields',
    input: {
      requested: ['flavor'],
      products: [{ brand: null, flavor: 'Lemon' }],
      locale: 'en',
    },
  },
];

/** Deterministic LCG so the adversarial draws are reproducible across CI runs. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** Labels the stochastic assessor has been observed (or could plausibly) emit. */
const ADVERSARIAL_LABELS = [
  'marka', 'brandi', 'ma shum', 'cila eshte me e mire', 'më e mirë',
  'pesha', 'shija', 'ngjyra', 'informacion shtesë', 'detaje',
];

function adversarialAssessment(rng: () => number): Assessment {
  // ~1 in 5 draws simulates a transport/parse failure (errored, fail-closed shape).
  if (rng() < 0.2) return { answer: '', missing: [], ok: false, errored: true };
  const missing: string[] = [];
  const count = Math.floor(rng() * 3); // 0..2 spurious labels
  for (let i = 0; i < count; i++) {
    missing.push(ADVERSARIAL_LABELS[Math.floor(rng() * ADVERSARIAL_LABELS.length)]);
  }
  const answer = rng() < 0.5 ? 'Po, e kemi në stok. Kushton €18.00.' : 'Po.';
  return { answer, missing, ok: true, errored: false };
}

describe('golden-set determinism assertion (RC-01 permanent fixture)', () => {
  const RUNS = 20;
  for (const { name, input } of GOLDEN_ANSWERABLE) {
    it(`${name}: identical no-escalate decision across ${RUNS} adversarial assessor draws`, () => {
      const rng = makeRng(0xc0ffee);
      for (let run = 0; run < RUNS; run++) {
        const outcome = decideOutcomeDeterministicFirst({
          ...input,
          assessment: adversarialAssessment(rng),
        });
        assert.equal(
          outcome.escalated,
          false,
          `run ${run + 1}: answerable question escalated (missing=${JSON.stringify(outcome.missing)})`,
        );
        assert.equal(outcome.reply, null, `run ${run + 1}: original AI reply was replaced`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Injected-error path — fail OPEN, unless a true deterministic gap exists
// ---------------------------------------------------------------------------

describe('assessor errored (transport/parse/empty)', () => {
  const errored: Assessment = { answer: '', missing: [], ok: false, errored: true };

  it('fails OPEN when the deterministic net is clear — AI reply sent as-is', () => {
    const outcome = decideOutcomeDeterministicFirst({
      assessment: errored,
      requested: ['flavor'],
      products: [{ flavor: 'Lemon' }],
      locale: 'en',
    });
    assert.equal(outcome.escalated, false);
    assert.equal(outcome.reply, null);
  });

  it('still escalates a genuinely absent structured attribute despite the error', () => {
    const outcome = decideOutcomeDeterministicFirst({
      assessment: errored,
      requested: ['brand'],
      products: [{ brand: null, flavor: 'Lemon' }],
      locale: 'sq',
    });
    assert.equal(outcome.escalated, true);
    assert.equal(outcome.status, 'none');
    assert.ok((outcome.reply as string).includes('marka'));
  });
});

// ---------------------------------------------------------------------------
// True gaps must still escalate (the gate keeps its teeth)
// ---------------------------------------------------------------------------

describe('true gaps under deterministic-first', () => {
  it('requested structured attribute absent from every signal → escalates', () => {
    const outcome = decideOutcomeDeterministicFirst({
      assessment: { answer: '', missing: ['brand'], ok: true, errored: false },
      requested: ['brand'],
      products: [{ brand: null }],
      locale: 'en',
    });
    assert.equal(outcome.escalated, true);
    assert.equal(outcome.status, 'none');
  });

  it('allowlisted free-form gap (ingredients) → partial answer + escalation', () => {
    const outcome = decideOutcomeDeterministicFirst({
      assessment: {
        answer: 'The price is €20.',
        missing: ['ingredients'],
        ok: true,
        errored: false,
      },
      requested: [],
      products: [{ brand: 'Acme' }],
      locale: 'en',
    });
    assert.equal(outcome.escalated, true);
    assert.equal(outcome.status, 'partial');
    assert.equal(
      outcome.reply,
      'The price is €20. We will notify you shortly regarding the ingredients information.',
    );
  });

  it('multi-product per-attribute gap → escalates via the deterministic per-product pass', () => {
    const outcome = decideOutcomeDeterministicFirst({
      assessment: {
        answer: 'Carbo One 1kg vjen me shije limoni.',
        missing: [],
        ok: true,
        errored: false,
      },
      requested: ['flavor'],
      products: [{ flavor: 'Limon' }, { flavor: null }],
      locale: 'sq',
    });
    assert.equal(outcome.escalated, true);
    assert.equal(outcome.status, 'partial');
    assert.ok(outcome.missing.some((label) => label.toLowerCase().includes('shij')));
  });

  it('image-derived packaging read counts as available (no escalation)', () => {
    const outcome = decideOutcomeDeterministicFirst({
      assessment: { answer: 'The brand is BioTech.', missing: [], ok: true, errored: false },
      requested: ['brand'],
      products: [{ brand: null }],
      imageUsableKeys: new Set(['brand']),
      locale: 'en',
    });
    assert.equal(outcome.escalated, false);
  });
});
