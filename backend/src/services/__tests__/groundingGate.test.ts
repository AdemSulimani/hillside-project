/**
 * Tests for the P2-1 consolidated deterministic grounding gate + facts_used contract.
 *
 * Acceptance surface (from the remediation item):
 *  - EV-011/013/015 replay → ZERO flags (prices/names match active catalog rows).
 *  - conv fcd0af7e → the two real in-stock products are SENT (targeted, not blanket-replaced).
 *  - Determinism → identical verdict across N≥20 runs on identical input.
 *  - Facts-token-membership → every catalog-absent price/name asserted in prose is caught; none
 *    survives in the sent text.
 *  - Property → any active-catalog price never flags regardless of the retrieval window (the gate
 *    validates against the full-catalog set only; it never receives matchedProducts).
 *  - Negative → a genuinely fabricated price/name still flags (targeted strip or escalate).
 *  - Schema/backstop reconciliation → a price/name stated in prose but NOT declared in facts_used
 *    is still caught by the deterministic backstop.
 *  - Fail policy → a catalog-index infra error → infra_error verdict, escalate, fail-closed, the
 *    distinct retryable reason grounding_check_unavailable (never fail-open).
 *  - Parser → valid / truncated (finish_reason:length) / malformed → retryable classification.
 *
 * Runs fully in-process: the pure `evaluateGroundingFacts` needs no I/O, and
 * `evaluateConsolidatedGrounding` takes its catalog/LLM collaborators as injected `deps`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateGroundingFacts,
  evaluateConsolidatedGrounding,
  parseFactsUsedCompletion,
  GenerationContractError,
  type DeclaredFact,
  type GroundingGateDeps,
} from '../groundingGate';
import {
  buildPriceSetFromCatalogRows,
  verifySuspectedNamesAgainstCatalog,
} from '../catalogGuardReferenceService';
import type { SimilarProductName } from '../../db/models/product';

const TENANT = '00000000-0000-0000-0000-000000000001';

// EV-013 active catalog rows (prices as pg returns them — strings) and the EV-011 name index.
const EV_CATALOG_ROWS = [
  { price: '95.00', discounted_price: null }, // Mega mass 7kg Qokolad
  { price: '55.00', discounted_price: null }, // Mega mass 3kg Vanil
  { price: '52.00', discounted_price: null }, // Mass gainer 3kg Qokolad
  { price: '18.00', discounted_price: null }, // Carbo One 1kg Orange
];
const EV_NAME_INDEX = [
  'Mega mass 7kg Qokolad',
  'Mega mass 3kg Vanil',
  'Mass gainer 3kg Qokolad',
  'Carbo One 1kg Orange',
  // The unrelated top-10 retrieval window from EV-011 stays active in the catalog:
  'Melatonine 180tab',
  'Pure Creatine 100 capsul',
];
const EV_PRICE_SET = buildPriceSetFromCatalogRows(EV_CATALOG_ROWS);

/** Similarity lookup stub that always misses (a fabrication has no near catalog match). */
const missLookup =
  () =>
  async (_t: string, _candidate: string, _min: number): Promise<SimilarProductName | null> =>
    null;

/** Build gate deps from a fixed price set / name index + a suspect list, using the REAL verifier. */
function fakeDeps(overrides: Partial<GroundingGateDeps> & { suspects?: string[] } = {}): GroundingGateDeps {
  const suspects = overrides.suspects ?? [];
  return {
    getPriceSet: overrides.getPriceSet ?? (async () => EV_PRICE_SET),
    getNameIndex: overrides.getNameIndex ?? (async () => EV_NAME_INDEX),
    suspectNames:
      overrides.suspectNames ??
      (async () => ({ hasHallucination: suspects.length > 0, suspectedNames: suspects })),
    verifyNames:
      overrides.verifyNames ??
      ((t, s, index) => verifySuspectedNamesAgainstCatalog(t, s, index, missLookup())),
  };
}

// ---------------------------------------------------------------------------
// parseFactsUsedCompletion — the facts_used contract parser
// ---------------------------------------------------------------------------

describe('parseFactsUsedCompletion', () => {
  it('parses a valid { facts_used, prose } completion', () => {
    const out = parseFactsUsedCompletion(
      JSON.stringify({
        prose: 'Carbo One 1kg Orange kushton €18.00.',
        facts_used: [
          { type: 'price', product_ref: 'Carbo One 1kg Orange', value: '18.00' },
          { type: 'name', product_ref: 'Carbo One 1kg Orange', value: 'Carbo One 1kg Orange' },
        ],
      }),
    );
    assert.equal(out.prose, 'Carbo One 1kg Orange kushton €18.00.');
    assert.equal(out.facts_used.length, 2);
    assert.equal(out.facts_used[0].type, 'price');
  });

  it('accepts an empty facts_used list', () => {
    const out = parseFactsUsedCompletion(JSON.stringify({ prose: 'Përshëndetje!', facts_used: [] }));
    assert.deepEqual(out.facts_used, []);
    assert.equal(out.prose, 'Përshëndetje!');
  });

  it('throws a RETRYABLE truncation error on finish_reason=length', () => {
    assert.throws(
      () => parseFactsUsedCompletion('{"prose":"partial', 'length'),
      (err) => err instanceof GenerationContractError && err.kind === 'truncated',
    );
  });

  it('throws a parse error on invalid JSON', () => {
    assert.throws(
      () => parseFactsUsedCompletion('{not json', 'stop'),
      (err) => err instanceof GenerationContractError && err.kind === 'parse',
    );
  });

  it('throws a parse error on empty content', () => {
    assert.throws(
      () => parseFactsUsedCompletion('', 'stop'),
      (err) => err instanceof GenerationContractError && err.kind === 'parse',
    );
  });

  it('throws a shape error when prose is missing', () => {
    assert.throws(
      () => parseFactsUsedCompletion(JSON.stringify({ facts_used: [] }), 'stop'),
      (err) => err instanceof GenerationContractError && err.kind === 'shape',
    );
  });

  it('coerces malformed fact entries and drops empty-value facts', () => {
    const out = parseFactsUsedCompletion(
      JSON.stringify({
        prose: 'ok',
        facts_used: [
          { type: 'weird', product_ref: 'x', value: 'kept' }, // unknown type → 'attribute'
          { type: 'price', product_ref: 'y', value: '' }, // empty value → dropped
          { type: 'name', value: 'z' }, // missing product_ref → '' but kept
        ],
      }),
    );
    assert.equal(out.facts_used.length, 2);
    assert.equal(out.facts_used[0].type, 'attribute');
    assert.equal(out.facts_used[1].value, 'z');
  });
});

// ---------------------------------------------------------------------------
// evaluateGroundingFacts — the pure gate core
// ---------------------------------------------------------------------------

describe('evaluateGroundingFacts (pure)', () => {
  it('grounded: a reply with no ungrounded facts is sent unchanged', () => {
    const prose = 'Shijet: Limon, Portokall. Çmimi: €18.00 për secilën.';
    const v = evaluateGroundingFacts({ prose, priceSet: EV_PRICE_SET, ungroundedNames: [], stripFloor: 24 });
    assert.equal(v.status, 'grounded');
    assert.equal(v.escalate, false);
    assert.equal(v.text, prose);
    assert.deepEqual(v.ungroundedPrices, []);
  });

  it('EV-011/015: €18.00 with an EMPTY retrieval window does not flag (full-catalog set)', () => {
    // The gate never receives matchedProducts — only the full-catalog price set — so the
    // window being empty is irrelevant by construction.
    const v = evaluateGroundingFacts({
      prose: 'Limon: €18.00 Portokall: €18.00',
      priceSet: EV_PRICE_SET,
      ungroundedNames: [],
      stripFloor: 24,
    });
    assert.equal(v.status, 'grounded');
  });

  it('fcd0af7e: two real product names + a real price are all grounded → both products sent', () => {
    const prose =
      'Ju rekomandoj Mega mass 3kg Vanil dhe Mass gainer 3kg Qokolad. Çmimi fillon nga €52.00.';
    const v = evaluateGroundingFacts({
      prose,
      priceSet: EV_PRICE_SET,
      ungroundedNames: [], // both names verified against the full catalog upstream → grounded
      stripFloor: 24,
    });
    assert.equal(v.status, 'grounded');
    assert.equal(v.text, prose);
    assert.match(v.text, /Mega mass 3kg Vanil/);
    assert.match(v.text, /Mass gainer 3kg Qokolad/);
  });

  it('property: every active-catalog price is grounded regardless of window', () => {
    for (const price of EV_PRICE_SET.prices) {
      const v = evaluateGroundingFacts({
        prose: `Çmimi është €${price.toFixed(2)}.`,
        priceSet: EV_PRICE_SET,
        ungroundedNames: [],
        stripFloor: 24,
      });
      assert.equal(v.status, 'grounded', `price ${price} should be grounded`);
    }
  });

  it('negative price, single sentence: a fabricated price escalates (nothing grounded survives)', () => {
    const v = evaluateGroundingFacts({
      prose: 'Çmimi është €23.50.',
      priceSet: EV_PRICE_SET,
      ungroundedNames: [],
      stripFloor: 24,
    });
    assert.equal(v.escalate, true);
    assert.equal(v.status, 'escalate');
    assert.equal(v.reason, 'hallucinated_price');
    assert.deepEqual(v.ungroundedPrices, ['23.50']);
  });

  it('targeted strip: keeps the grounded sentence, removes only the fabricated-price sentence', () => {
    const prose = 'Kemi Carbo One 1kg Orange për €18.00. Gjithashtu një ofertë speciale për €23.50.';
    const v = evaluateGroundingFacts({ prose, priceSet: EV_PRICE_SET, ungroundedNames: [], stripFloor: 24 });
    assert.equal(v.status, 'stripped');
    assert.equal(v.escalate, false);
    assert.match(v.text, /Carbo One 1kg Orange për €18\.00/);
    assert.doesNotMatch(v.text, /23\.50/); // the ungrounded price does NOT survive
  });

  it('targeted strip: removes only the sentence carrying a fabricated product name', () => {
    const prose = 'Kemi Carbo One 1kg Orange në stok. Gjithashtu kemi Ghost Whey Protein 2kg.';
    const v = evaluateGroundingFacts({
      prose,
      priceSet: EV_PRICE_SET,
      ungroundedNames: ['Ghost Whey Protein 2kg'],
      stripFloor: 24,
    });
    assert.equal(v.status, 'stripped');
    assert.match(v.text, /Carbo One 1kg Orange/);
    assert.doesNotMatch(v.text.toLowerCase(), /ghost whey protein/);
  });
});

// ---------------------------------------------------------------------------
// evaluateConsolidatedGrounding — the async orchestrator (injected deps)
// ---------------------------------------------------------------------------

describe('evaluateConsolidatedGrounding (orchestrator)', () => {
  const baseInput = {
    tenantId: TENANT,
    nameLlmCap: 150,
    stripFloor: 24,
  };

  it('grounded: real names + real price pass end-to-end', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose: 'Kemi Carbo One 1kg Orange për €18.00.',
      factsUsed: [
        { type: 'name', product_ref: 'Carbo One 1kg Orange', value: 'Carbo One 1kg Orange' },
        { type: 'price', product_ref: 'Carbo One 1kg Orange', value: '18.00' },
      ],
      deps: fakeDeps({ suspects: ['Carbo One 1kg Orange'] }),
    });
    assert.equal(v.status, 'grounded');
    assert.equal(v.escalate, false);
  });

  it('name rescue: a declared/suspected name that IS in the catalog does not flag', async () => {
    // Suspecter surfaces a real name; the deterministic verifier rescues it via the name index.
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose: 'Ju rekomandoj Mass gainer 3kg Qokolad.',
      factsUsed: [],
      deps: fakeDeps({ suspects: ['Mass gainer 3kg Qokolad'] }),
    });
    assert.equal(v.status, 'grounded');
    assert.deepEqual(v.ungroundedNames, []);
  });

  it('negative name: a fabricated declared name (absent from catalog) is caught', async () => {
    const prose = 'Ne kemi Ghost Whey Protein 2kg në stok.';
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose,
      factsUsed: [{ type: 'name', product_ref: 'x', value: 'Ghost Whey Protein 2kg' }],
      deps: fakeDeps({ suspects: ['Ghost Whey Protein 2kg'] }),
    });
    assert.equal(v.escalate, true);
    assert.equal(v.reason, 'hallucinated_product_name');
    assert.deepEqual(v.ungroundedNames, ['Ghost Whey Protein 2kg']);
  });

  it('backstop: a fabricated name in prose but NOT declared is still caught via the suspecter', async () => {
    const prose = 'Kemi Carbo One 1kg Orange në stok. Provoni edhe Ghost Whey Protein 2kg.';
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose,
      factsUsed: [], // model declared nothing
      deps: fakeDeps({ suspects: ['Ghost Whey Protein 2kg'] }),
    });
    assert.equal(v.status, 'stripped'); // grounded first sentence survives
    assert.match(v.text, /Carbo One 1kg Orange/);
    assert.doesNotMatch(v.text.toLowerCase(), /ghost whey protein/);
  });

  it('backstop: a fabricated price in prose but NOT declared is still caught (prose is authoritative)', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose: 'Çmimi është €23.50.',
      factsUsed: [], // model declared no price
      deps: fakeDeps(),
    });
    assert.equal(v.escalate, true);
    assert.equal(v.reason, 'hallucinated_price');
  });

  it('only names present in prose drive a strip (a declared name absent from prose is ignored)', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose: 'Përshëndetje! Si mund t’ju ndihmoj?',
      factsUsed: [{ type: 'name', product_ref: 'x', value: 'Ghost Whey Protein 2kg' }],
      deps: fakeDeps({ suspects: ['Ghost Whey Protein 2kg'] }),
    });
    assert.equal(v.status, 'grounded');
    assert.deepEqual(v.ungroundedNames, []);
  });

  it('fail policy: a catalog-index infra error fails CLOSED with a distinct retryable reason', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose: 'Kemi Carbo One 1kg Orange për €18.00.',
      factsUsed: [],
      deps: fakeDeps({
        getPriceSet: async () => {
          throw new Error('DB down');
        },
      }),
    });
    assert.equal(v.status, 'infra_error');
    assert.equal(v.escalate, true);
    assert.equal(v.failClosed, true);
    assert.equal(v.reason, 'grounding_check_unavailable');
  });

  it('name suspecter failure fails OPEN (residue error must not escalate a grounded reply)', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose: 'Kemi Carbo One 1kg Orange për €18.00.',
      factsUsed: [],
      deps: fakeDeps({
        suspectNames: async () => {
          throw new Error('classifier down');
        },
      }),
    });
    assert.equal(v.status, 'grounded');
  });

  it('determinism: identical input yields an identical verdict across 20 runs', async () => {
    const prose = 'Kemi Carbo One 1kg Orange për €18.00. Gjithashtu një ofertë për €23.50.';
    const runs = await Promise.all(
      Array.from({ length: 20 }, () =>
        evaluateConsolidatedGrounding({
          ...baseInput,
          prose,
          factsUsed: [{ type: 'price', product_ref: 'x', value: '23.50' }],
          deps: fakeDeps(),
        }),
      ),
    );
    const first = JSON.stringify({ status: runs[0].status, text: runs[0].text });
    for (const v of runs) {
      assert.equal(JSON.stringify({ status: v.status, text: v.text }), first);
    }
    assert.equal(runs[0].status, 'stripped');
    assert.doesNotMatch(runs[0].text, /23\.50/);
  });

  it('facts-token-membership: no catalog-absent price/name survives in the sent text', async () => {
    const prose =
      'Kemi Carbo One 1kg Orange për €18.00. Kemi edhe Ghost Whey Protein 2kg për €23.50.';
    const v = await evaluateConsolidatedGrounding({
      ...baseInput,
      prose,
      factsUsed: [
        { type: 'name', product_ref: 'x', value: 'Ghost Whey Protein 2kg' },
        { type: 'price', product_ref: 'x', value: '23.50' },
      ],
      deps: fakeDeps({ suspects: ['Ghost Whey Protein 2kg'] }),
    });
    // Whatever the gate sends (stripped remainder or a holding escalation), the fabricated fact
    // must never reach the customer.
    const sent = v.escalate ? '' : v.text;
    assert.doesNotMatch(sent, /23\.50/);
    assert.doesNotMatch(sent.toLowerCase(), /ghost whey protein/);
  });
});
