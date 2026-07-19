/**
 * Tests for the P1-5 model pricing util (OBS-2 / C-108): the ledger's per-reply USD cost.
 * Pure/in-process (no network/DB). Covers base + dated-snapshot + fine-tuned models and the
 * "unknown model / missing usage -> null (never a fabricated 0)" contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cachedInputRate, computeCost, resolveModelPrice } from '../modelPricing';

describe('modelPricing', () => {
  it('prices a base chat model from prompt + completion tokens', () => {
    // gpt-4o = $2.50/1M in, $10/1M out. 1000 in + 500 out = 0.0025 + 0.005 = 0.0075.
    const cost = computeCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 500 });
    assert.equal(cost, 0.0075);
  });

  it('resolves a dated snapshot to its family via longest-prefix match', () => {
    const price = resolveModelPrice('gpt-4o-2024-08-06');
    // P3-6 added `cachedInputPerM` (half the input rate, the published gpt-4o-family discount).
    assert.deepEqual(price, { inputPerM: 2.5, outputPerM: 10, cachedInputPerM: 1.25 });
  });

  it('prices a fine-tuned model at the ft:* premium, not the base rate', () => {
    // ft:gpt-4o-... = $3.75/1M in, $15/1M out.
    const cost = computeCost('ft:gpt-4o-2024-08-06:my-org::abc123', {
      prompt_tokens: 1_000_000,
      completion_tokens: 0,
    });
    assert.equal(cost, 3.75);
    // ...and is distinct from the base gpt-4o price for the same usage.
    const base = computeCost('gpt-4o', { prompt_tokens: 1_000_000, completion_tokens: 0 });
    assert.equal(base, 2.5);
  });

  it('returns null for an unknown model (visible, not a fake 0)', () => {
    assert.equal(resolveModelPrice('some-unknown-model'), null);
    assert.equal(computeCost('some-unknown-model', { prompt_tokens: 100, completion_tokens: 100 }), null);
  });

  it('returns null when usage is missing', () => {
    assert.equal(computeCost('gpt-4o', null), null);
    assert.equal(computeCost('gpt-4o', undefined), null);
  });

  it('treats missing token fields as zero', () => {
    assert.equal(computeCost('gpt-4o', { prompt_tokens: 1000 }), 0.0025);
  });

  it('returns null for a null/empty model', () => {
    assert.equal(resolveModelPrice(null), null);
    assert.equal(resolveModelPrice(undefined), null);
    assert.equal(resolveModelPrice(''), null);
  });
});

/**
 * P3-6. Two additions with opposite risk profiles: cached-input pricing makes the number SMALLER
 * (so it must not be able to go negative or over-discount), and embedding pricing makes it
 * BIGGER (it was silently null, i.e. one unpriced call per reply).
 */
describe('modelPricing — cached input (P3-6)', () => {
  it('re-prices cached prompt tokens rather than adding a term', () => {
    // 1000 prompt of which 800 cached: 200 @ 2.5/M + 800 @ 1.25/M = 0.0005 + 0.001 = 0.0015.
    const cost = computeCost('gpt-4o', {
      prompt_tokens: 1000,
      completion_tokens: 0,
      cached_tokens: 800,
    });
    assert.equal(cost, 0.0015);
    // Strictly cheaper than the same call uncached, and never more than the full-price total.
    const uncached = computeCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 0 })!;
    assert.ok(cost! < uncached);
  });

  it('is byte-identical to the pre-P3-6 result when cached_tokens is absent', () => {
    // The back-compat contract: every historical assertion in this file must still hold, so a
    // usage blob without the new field must take exactly the old arithmetic.
    assert.equal(computeCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 500 }), 0.0075);
    assert.equal(
      computeCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 500, cached_tokens: 0 }),
      0.0075,
    );
  });

  it('clamps cached_tokens above prompt_tokens instead of producing a negative uncached term', () => {
    // A provider reporting more cached than prompt tokens is nonsense; letting it through would
    // make the uncached remainder negative and UNDERSTATE cost — the failure direction that
    // reads as good news.
    const clamped = computeCost('gpt-4o', {
      prompt_tokens: 1000,
      completion_tokens: 0,
      cached_tokens: 5000,
    });
    assert.equal(clamped, 0.00125, 'all 1000 tokens priced at the cached rate, none negative');
    assert.ok(clamped! > 0);
  });

  it('ignores a negative or non-finite cached_tokens', () => {
    assert.equal(
      computeCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 0, cached_tokens: -50 }),
      0.0025,
    );
    assert.equal(
      computeCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 0, cached_tokens: NaN }),
      0.0025,
    );
  });

  it('applies NO discount when a price entry omits cachedInputPerM', () => {
    // Deliberately conservative: an operator override that did not state a cached rate must not
    // have half-price assumed on its behalf. An unknown discount is priced as no discount.
    process.env.OPENAI_MODEL_PRICES = '';
    const price = resolveModelPrice('gpt-4o')!;
    assert.equal(cachedInputRate({ inputPerM: price.inputPerM, outputPerM: price.outputPerM }), 2.5);
  });
});

describe('modelPricing — embeddings (P3-6)', () => {
  it('prices the deployed embedding model instead of recording null', () => {
    // Before P3-6 every retrieval embedding recorded `usd_cost: null` — one unpriced call per
    // reply, invisible in the COGS total.
    const cost = computeCost('text-embedding-3-small', { prompt_tokens: 1_000_000 });
    assert.equal(cost, 0.02);
  });

  it('prices an embedding as input-only', () => {
    // outputPerM: 0 is a REAL price here, not a missing one — an embedding response has no
    // completion tokens, so the term is genuinely zero rather than unknown.
    const withOutput = computeCost('text-embedding-3-small', {
      prompt_tokens: 1_000_000,
      completion_tokens: 1_000_000,
    });
    assert.equal(withOutput, 0.02);
  });

  it('does not collide with the gpt-* prefix table', () => {
    assert.equal(resolveModelPrice('text-embedding-3-large')!.inputPerM, 0.13);
    assert.equal(resolveModelPrice('text-embedding-ada-002')!.inputPerM, 0.1);
  });
});
