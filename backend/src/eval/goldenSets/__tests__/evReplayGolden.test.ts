/**
 * P3-4 GOLDEN SET — EV replay (RC-02). THIS IS A RELEASE GATE.
 *
 * THE FINDING: every "hallucination" alert in the dev database was a FALSE POSITIVE. All three
 * (EV-011) fired on factually correct replies about active, in-stock catalog rows — EV-013
 * cross-checked each one. The guards meant to prevent hallucination were the largest single source
 * of false escalations, and each one ended the conversation (16/20 alerts sit at or within one
 * message of the final message; there is no auto-resume).
 *
 * ⚠️ THE PRE-FIX/POST-FIX SWITCH HERE IS NOT A FLAG — unlike RC-01's, where `decideGapEscalation`
 * carries both policies. The P0-2 fix changed WHICH REFERENCE SET IS INJECTED: the guards used to
 * judge a reply against `matchedProducts` (this turn's volatile ~10–25 retrieved rows) and now
 * judge it against the full active catalog. So the meta-test flips
 * `GroundingGateDeps.getPriceSet`/`getNameIndex` between the recorded retrieval window and the full
 * catalog. Read the suite with that in mind or the structure looks arbitrary.
 *
 * Offline: `evaluateGroundingFacts` is pure and `evaluateConsolidatedGrounding` takes its catalog
 * and LLM collaborators as injected deps. No DB, Redis, network or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateConsolidatedGrounding,
  evaluateGroundingFacts,
  type GroundingGateDeps,
} from '../../../services/groundingGate';
import {
  buildPriceSetFromCatalogRows,
  verifySuspectedNamesAgainstCatalog,
} from '../../../services/catalogGuardReferenceService';
import type { SimilarProductName } from '../../../db/models/product';
import {
  EV_ALERT_CASES,
  EMPTY_WINDOW_PRICE_SET,
  FABRICATED_NAME,
  FABRICATED_PRICE,
  FCD0AF7E_TRANSCRIPT,
  FULL_CATALOG_NAMES,
  FULL_CATALOG_PRICE_SET,
  FULL_CATALOG_ROWS,
  RETRIEVAL_WINDOW_NAMES,
  RETRIEVAL_WINDOW_PRICE_SET,
} from '../../corpora/evReplay';

const TENANT = '00000000-0000-0000-0000-000000000001';
const STRIP_FLOOR = 24;

/** A pg_trgm lookup that always misses — a genuine fabrication has no near catalog match. */
const missLookup =
  () =>
  async (_t: string, _candidate: string, _min: number): Promise<SimilarProductName | null> =>
    null;

function deps(overrides: Partial<GroundingGateDeps> & { suspects?: string[] } = {}): GroundingGateDeps {
  const suspects = overrides.suspects ?? [];
  return {
    getPriceSet: overrides.getPriceSet ?? (async () => FULL_CATALOG_PRICE_SET),
    getNameIndex: overrides.getNameIndex ?? (async () => [...FULL_CATALOG_NAMES]),
    suspectNames:
      overrides.suspectNames ??
      (async () => ({ hasHallucination: suspects.length > 0, suspectedNames: suspects })),
    verifyNames:
      overrides.verifyNames ??
      ((t, s, index) => verifySuspectedNamesAgainstCatalog(t, s, index, missLookup())),
  };
}

// ---------------------------------------------------------------------------
// The replay: zero flags against the full catalog
// ---------------------------------------------------------------------------

describe('RC-02 EV replay: every recorded alert was a false positive', () => {
  it('the corpus still carries all three alerts (guard on the guard)', () => {
    assert.equal(EV_ALERT_CASES.length, 3);
    assert.deepEqual(
      EV_ALERT_CASES.map((c) => c.alertId).sort(),
      ['6e13dbe6', 'e37cd2ce', 'ef3393c1'],
    );
  });

  for (const c of EV_ALERT_CASES) {
    it(`${c.alertId} (${c.reason}, conv ${c.conversationId}) — ZERO flags against the full catalog`, async () => {
      const verdict = await evaluateConsolidatedGrounding({
        tenantId: TENANT,
        prose: c.originalReply,
        factsUsed: null,
        // The suspects the pre-fix name guard surfaced are still surfaced — the FIX is that the
        // deterministic verifier now rescues them against the full catalog.
        deps: deps({ suspects: [...c.suspectedNames] }),
        nameLlmCap: 10,
        stripFloor: STRIP_FLOOR,
      });
      assert.equal(
        verdict.escalate,
        false,
        `${c.alertId} still escalates. ${c.rationale}`,
      );
      assert.equal(verdict.status, 'grounded', `${c.alertId}: reply was altered, not sent as-is`);
      assert.equal(verdict.text, c.originalReply, 'the correct reply must reach the customer intact');
    });
  }

  it('property: EVERY active-catalog price is grounded, whatever the retrieval window held', () => {
    // RC-02 in one assertion — window membership is irrelevant to correctness by construction.
    for (const price of FULL_CATALOG_PRICE_SET.prices) {
      const v = evaluateGroundingFacts({
        prose: `Çmimi është €${price.toFixed(2)}.`,
        priceSet: FULL_CATALOG_PRICE_SET,
        ungroundedNames: [],
        stripFloor: STRIP_FLOOR,
      });
      assert.equal(v.status, 'grounded', `price ${price} flagged`);
    }
  });

  it('fcd0af7e: the stripped recommendation names two products the AI itself listed in turn 2', () => {
    const turn2 = FCD0AF7E_TRANSCRIPT.find((t) => t.turn === 2);
    const alert = EV_ALERT_CASES.find((c) => c.conversationId === 'fcd0af7e');
    assert.ok(turn2 && alert);
    // The corpus's own coherence check: the "hallucinated" names are in the AI's earlier message.
    for (const name of alert.suspectedNames) {
      const stem = name.toLowerCase().split(' ')[0];
      assert.ok(
        turn2.content.toLowerCase().includes(stem),
        `"${name}" is not traceable to turn 2 — the transcript fixture has drifted`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The meta-test: dependency injection, not a flag
// ---------------------------------------------------------------------------

describe('RC-02 meta-test: the PRE-FIX reference set reproduces the false positives', () => {
  it('WINDOW-scoped price set + a correct €18.00 → the pre-fix guard FLAGS it', () => {
    // The RC-02 mechanism itself: judge the reply against this turn's retrieved rows and a real
    // catalog price that happens to be outside the window reads as invented.
    const v = evaluateGroundingFacts({
      prose: 'Limon: €18.00 Portokall: €18.00',
      priceSet: RETRIEVAL_WINDOW_PRICE_SET, // ← the pre-fix reference set
      ungroundedNames: [],
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(v.escalate, true, 'the pre-fix defect no longer reproduces — meta-test is vacuous');
    assert.equal(v.reason, 'hallucinated_price');
    assert.deepEqual(v.ungroundedPrices, ['18.00']);
  });

  it('the window fixture genuinely excludes the correct price (else the test above is theatre)', () => {
    assert.ok(
      !RETRIEVAL_WINDOW_PRICE_SET.prices.includes(18),
      'the constructed window prices must not contain the price the reply correctly stated',
    );
    assert.ok(FULL_CATALOG_PRICE_SET.prices.includes(18), '€18.00 must be a real catalog price');
  });

  it('the recorded no_catalog_prices fail-CLOSED path is gone: an empty set now fails OPEN', () => {
    // Both hallucinated_price alerts recorded `catalogPrices: []` / failureReason
    // "no_catalog_prices" — the filter stripped a correct reply while holding nothing to compare
    // against. P0-2 made that path fail open ("can't validate nothing"). Pinned, because a
    // regression back to fail-closed would resurrect two of the three false positives verbatim.
    const v = evaluateGroundingFacts({
      prose: 'Limon: €18.00 Portokall: €18.00',
      priceSet: EMPTY_WINDOW_PRICE_SET,
      ungroundedNames: [],
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(v.escalate, false);
    assert.equal(v.status, 'grounded');
  });

  it('the SAME reply against the full catalog → grounded', () => {
    const v = evaluateGroundingFacts({
      prose: 'Limon: €18.00 Portokall: €18.00',
      priceSet: FULL_CATALOG_PRICE_SET, // ← the post-fix reference set
      ungroundedNames: [],
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(v.escalate, false);
    assert.equal(v.status, 'grounded');
  });

  it('the unrelated top-10 window does not contain the mass-gainer names (why the guard misfired)', () => {
    // The mechanical cause, asserted rather than described: turn 5 carried no product keywords, so
    // retrieval returned Melatonine/Creatine/C4 and the name guard could not "see" the real rows.
    for (const name of ['Mega mass 3kg Qokolad', 'Mass gainer 3kg Qokolad']) {
      assert.ok(!RETRIEVAL_WINDOW_NAMES.includes(name), `${name} unexpectedly in the window`);
      assert.ok(FULL_CATALOG_NAMES.includes(name), `${name} missing from the full catalog fixture`);
    }
  });

  it('pre-fix name index → the fcd0af7e recommendation is NOT rescued; post-fix → it is', async () => {
    const prose = EV_ALERT_CASES.find((c) => c.alertId === 'ef3393c1')!.originalReply;
    const suspects = ['Mega Mass 3kg Qokolad', 'Mass gainer 3kg Qokolad'];

    const preFix = await evaluateConsolidatedGrounding({
      tenantId: TENANT,
      prose,
      factsUsed: null,
      deps: deps({ suspects, getNameIndex: async () => [...RETRIEVAL_WINDOW_NAMES] }),
      nameLlmCap: 10,
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(preFix.status !== 'grounded', true, 'the pre-fix window no longer misfires');

    const postFix = await evaluateConsolidatedGrounding({
      tenantId: TENANT,
      prose,
      factsUsed: null,
      deps: deps({ suspects }),
      nameLlmCap: 10,
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(postFix.status, 'grounded');
  });
});

// ---------------------------------------------------------------------------
// Anti-vacuity: a real fabrication must still be caught
// ---------------------------------------------------------------------------

describe('RC-02 anti-vacuity: widening the reference set did not disable the gate', () => {
  it('a genuinely fabricated price still escalates', () => {
    const v = evaluateGroundingFacts({
      prose: `Çmimi është €${FABRICATED_PRICE}.`,
      priceSet: FULL_CATALOG_PRICE_SET,
      ungroundedNames: [],
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(v.escalate, true);
    assert.equal(v.reason, 'hallucinated_price');
    assert.deepEqual(v.ungroundedPrices, [FABRICATED_PRICE]);
  });

  it('a genuinely fabricated product name still escalates', async () => {
    const verdict = await evaluateConsolidatedGrounding({
      tenantId: TENANT,
      prose: `Ju rekomandoj ${FABRICATED_NAME}.`,
      factsUsed: null,
      deps: deps({ suspects: [FABRICATED_NAME] }),
      nameLlmCap: 10,
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(verdict.escalate, true);
    assert.equal(verdict.reason, 'hallucinated_product_name');
  });

  it('targeted strip: a mixed reply keeps the grounded sentence and drops only the bad one', () => {
    // The fcd0af7e pathology was a BLANKET replace. Targeted stripping is the fix, so it is pinned.
    const v = evaluateGroundingFacts({
      prose: `Kemi Carbo One 1kg Orange për €18.00. Gjithashtu një ofertë speciale për €${FABRICATED_PRICE}.`,
      priceSet: FULL_CATALOG_PRICE_SET,
      ungroundedNames: [],
      stripFloor: STRIP_FLOOR,
    });
    assert.equal(v.status, 'stripped');
    assert.equal(v.escalate, false);
    assert.match(v.text, /Carbo One 1kg Orange për €18\.00/);
    assert.doesNotMatch(v.text, new RegExp(FABRICATED_PRICE.replace('.', '\\.')));
  });

  it('the catalog fixture is not empty (a vacuous price set would ground everything)', () => {
    assert.ok(FULL_CATALOG_ROWS.length >= 6);
    assert.ok(FULL_CATALOG_PRICE_SET.prices.length >= 4);
    assert.equal(EMPTY_WINDOW_PRICE_SET.prices.length, 0, 'the pre-fix fixture must stay empty');
    assert.notEqual(
      buildPriceSetFromCatalogRows([...FULL_CATALOG_ROWS]).prices.length,
      0,
      'the price-set builder returned nothing — the fixture shape has drifted from pg output',
    );
  });
});
