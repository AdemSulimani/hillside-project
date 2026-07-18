/**
 * P3-2 Step 2 (C-125 / RC-04) — the ef_search escalation predicate.
 *
 * The property that matters is ASYMMETRY: `eligibleCount` is an upper bound, so a wrong value can
 * only ever cost a missed optimisation, never a lost product. The cases below pin both directions —
 * the small-tenant waste is suppressed, and a genuine under-fill on a large tenant still escalates.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldEscalateEfSearch,
  clampEfSearch,
  type EfSearchEscalationInput,
} from '../vectorSearchPolicy';

/** Production defaults, so the cases read as real scenarios rather than abstract numbers. */
function input(overrides: Partial<EfSearchEscalationInput> = {}): EfSearchEscalationInput {
  return {
    firstPassCount: 0,
    effectiveLimit: 10,
    eligibleCount: null,
    efSearch: 100,
    efSearchMax: 500,
    ...overrides,
  };
}

describe('shouldEscalateEfSearch — the C-125 case', () => {
  it('declines for a tenant whose entire catalog is smaller than the limit', () => {
    // The measured dev tenant: 1 eligible product, FOCUSED_PRODUCT_MATCH_LIMIT = 10. Before this
    // predicate it escalated on 100% of its semantic queries and could never gain a row.
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 1, effectiveLimit: 10, eligibleCount: 1 })),
      false,
    );
  });

  it('declines whenever the first pass already holds every eligible row', () => {
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 6, effectiveLimit: 10, eligibleCount: 6 })),
      false,
    );
  });

  it('still escalates on a genuine under-fill for a large tenant', () => {
    // 3 of 10 returned while 5000 rows exist — exactly the global-index crowding the escalation
    // exists for. Suppressing this would be a recall regression.
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 3, effectiveLimit: 10, eligibleCount: 5000 })),
      true,
    );
  });

  it('escalates when the bound is only one row above what we hold', () => {
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 5, effectiveLimit: 10, eligibleCount: 6 })),
      true,
    );
  });

  it('tolerates an over-estimated bound by escalating — the safe direction', () => {
    // `countActiveProducts` does not filter on `embedding IS NOT NULL`, so it can exceed the true
    // eligible count. The consequence is a wasted pass, never a dropped product.
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 2, effectiveLimit: 10, eligibleCount: 50 })),
      true,
    );
  });
});

describe('shouldEscalateEfSearch — legacy-equivalent behaviour', () => {
  it('reproduces the legacy predicate when the count is unknown', () => {
    // The three call sites with no count in scope must behave byte-for-byte as before.
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 1, effectiveLimit: 10, eligibleCount: null })),
      true,
    );
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 10, effectiveLimit: 10, eligibleCount: null })),
      false,
    );
  });

  it('declines when the result set is already full, whatever the count says', () => {
    for (const eligibleCount of [null, 5, 10, 9999]) {
      assert.equal(
        shouldEscalateEfSearch(input({ firstPassCount: 10, effectiveLimit: 10, eligibleCount })),
        false,
        `full result set must never escalate (eligibleCount=${eligibleCount})`,
      );
    }
  });

  it('declines when the wider pool is not actually wider', () => {
    // Operator sets both knobs equal: the retry would repeat the identical query.
    assert.equal(
      shouldEscalateEfSearch(
        input({ firstPassCount: 1, effectiveLimit: 10, efSearch: 500, efSearchMax: 500 }),
      ),
      false,
    );
  });

  it('declines when the limit exceeds both knobs, so both passes clamp to the same floor', () => {
    assert.equal(
      shouldEscalateEfSearch(
        input({ firstPassCount: 5, effectiveLimit: 800, efSearch: 100, efSearchMax: 500 }),
      ),
      false,
    );
  });
});

describe('shouldEscalateEfSearch — the hysteresis-band trap', () => {
  it('uses the effective (inflated) limit, not the caller nominal limit', () => {
    // With the band on, the caller passes limit + SEMANTIC_BAND_EXTRA_DEPTH to SQL. A tenant with
    // 12 eligible rows returning 12 against an effective limit of 15 is exhausted, not starved.
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 12, effectiveLimit: 15, eligibleCount: 12 })),
      false,
    );
    // ...and the same 12 rows against a 12-row limit is simply full.
    assert.equal(
      shouldEscalateEfSearch(input({ firstPassCount: 12, effectiveLimit: 12, eligibleCount: 12 })),
      false,
    );
  });
});

describe('clampEfSearch', () => {
  it('never returns below the floor', () => {
    assert.equal(clampEfSearch(100, 250), 250);
    assert.equal(clampEfSearch(500, 10), 500);
  });

  it('rejects NaN and Infinity — they would render literally into SET LOCAL and throw', () => {
    // `SET LOCAL hnsw.ef_search = ${value}` is string-interpolated (a GUC is not bindable), so a
    // NaN reaching it errors INSIDE the similarity query's transaction and takes retrieval to zero.
    assert.equal(clampEfSearch(Number.NaN, 100), 100);
    assert.equal(clampEfSearch(Number.POSITIVE_INFINITY, 100), 100);
    assert.equal(clampEfSearch(Number.NEGATIVE_INFINITY, 100), 100);
  });

  it('rejects zero and negative values', () => {
    assert.equal(clampEfSearch(0, 40), 40);
    assert.equal(clampEfSearch(-5, 40), 40);
  });

  it('returns an integer even for fractional input', () => {
    assert.equal(clampEfSearch(123.9, 10), 123);
    assert.equal(Number.isInteger(clampEfSearch(10.5, 3.7)), true);
  });

  it('falls back to 1 when the floor itself is unusable', () => {
    assert.equal(clampEfSearch(Number.NaN, Number.NaN), 1);
    assert.equal(clampEfSearch(0, -3), 1);
  });
});
