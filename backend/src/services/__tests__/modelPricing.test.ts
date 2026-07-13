/**
 * Tests for the P1-5 model pricing util (OBS-2 / C-108): the ledger's per-reply USD cost.
 * Pure/in-process (no network/DB). Covers base + dated-snapshot + fine-tuned models and the
 * "unknown model / missing usage -> null (never a fabricated 0)" contract.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeCost, resolveModelPrice } from '../modelPricing';

describe('modelPricing', () => {
  it('prices a base chat model from prompt + completion tokens', () => {
    // gpt-4o = $2.50/1M in, $10/1M out. 1000 in + 500 out = 0.0025 + 0.005 = 0.0075.
    const cost = computeCost('gpt-4o', { prompt_tokens: 1000, completion_tokens: 500 });
    assert.equal(cost, 0.0075);
  });

  it('resolves a dated snapshot to its family via longest-prefix match', () => {
    const price = resolveModelPrice('gpt-4o-2024-08-06');
    assert.deepEqual(price, { inputPerM: 2.5, outputPerM: 10 });
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
