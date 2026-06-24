/**
 * Tests for the price-consistency guard (priceConsistencyGuard.ts).
 *
 * Key invariants:
 *  - extractStatedPrices detects prices in all supported formats (€-prefix,
 *    €-suffix, EUR suffix, ALL/LEK) and normalizes them correctly.
 *  - buildCatalogPriceSet picks up both the base price and the discounted price.
 *  - filterHallucinatedPrices returns the prices stated in the reply that have
 *    no matching catalog entry (within rounding tolerance).
 *  - Fail-open: when the catalog has no prices, no hallucination is flagged.
 *  - Replies stating no price are never flagged.
 *  - Rounding tolerance: 12.00 matches 12 in the catalog.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCatalogPriceSet,
  extractStatedPrices,
  filterHallucinatedPrices,
  replyPricesAreGrounded,
} from '../priceConsistencyGuard';

// ---------------------------------------------------------------------------
// extractStatedPrices
// ---------------------------------------------------------------------------

describe('extractStatedPrices', () => {
  it('detects €-prefix price (€25)', () => {
    const result = extractStatedPrices('The product costs €25.');
    assert.equal(result.length, 1);
    assert.equal(result[0].value, 25);
  });

  it('detects €-suffix price (12.50 €)', () => {
    const result = extractStatedPrices('Price: 12.50 €');
    assert.ok(result.some((p) => Math.abs(p.value - 12.50) < 0.01));
  });

  it('detects EUR suffix (19.99 EUR)', () => {
    const result = extractStatedPrices('Cost is 19.99 EUR.');
    assert.ok(result.some((p) => Math.abs(p.value - 19.99) < 0.01));
  });

  it('detects Albanian ALL (ALL 1500)', () => {
    const result = extractStatedPrices('Çmimi: ALL 1500');
    assert.ok(result.some((p) => Math.abs(p.value - 1500) < 0.01));
  });

  it('detects LEK suffix (1500 LEK)', () => {
    const result = extractStatedPrices('Kushton 1500 LEK.');
    assert.ok(result.some((p) => Math.abs(p.value - 1500) < 0.01));
  });

  it('handles European comma decimal notation (€12,50 → 12.50)', () => {
    const result = extractStatedPrices('Çmimi €12,50');
    assert.ok(result.some((p) => Math.abs(p.value - 12.50) < 0.01));
  });

  it('deduplicates the same numeric value appearing twice', () => {
    const result = extractStatedPrices('€25 and then again €25');
    // Same numeric part "25" deduped
    const twentyFives = result.filter((p) => Math.abs(p.value - 25) < 0.01);
    assert.equal(twentyFives.length, 1);
  });

  it('returns empty for a reply with no price mentions', () => {
    assert.equal(extractStatedPrices('We have this product in chocolate flavor.').length, 0);
  });
});

// ---------------------------------------------------------------------------
// buildCatalogPriceSet
// ---------------------------------------------------------------------------

describe('buildCatalogPriceSet', () => {
  it('includes both base price and discounted price', () => {
    const set = buildCatalogPriceSet([{ price: 25, discounted_price: 20 }]);
    assert.ok(set.prices.includes(25));
    assert.ok(set.prices.includes(20));
  });

  it('ignores null discounted_price', () => {
    const set = buildCatalogPriceSet([{ price: 30, discounted_price: null }]);
    assert.deepEqual(set.prices, [30]);
  });

  it('aggregates prices across multiple products', () => {
    const set = buildCatalogPriceSet([
      { price: 25, discounted_price: null },
      { price: 40, discounted_price: 35 },
    ]);
    assert.ok(set.prices.includes(25));
    assert.ok(set.prices.includes(40));
    assert.ok(set.prices.includes(35));
  });

  it('returns empty prices when products array is empty', () => {
    assert.deepEqual(buildCatalogPriceSet([]).prices, []);
  });
});

// ---------------------------------------------------------------------------
// filterHallucinatedPrices
// ---------------------------------------------------------------------------

describe('filterHallucinatedPrices', () => {
  it('returns empty when the reply price matches the catalog price exactly', () => {
    const catalog = buildCatalogPriceSet([{ price: 25, discounted_price: null }]);
    const hallucinated = filterHallucinatedPrices('The product is €25.', catalog);
    assert.equal(hallucinated.length, 0);
  });

  it('returns the hallucinated price when it does not match any catalog entry', () => {
    const catalog = buildCatalogPriceSet([{ price: 25, discounted_price: null }]);
    const hallucinated = filterHallucinatedPrices('The product is €30.', catalog);
    assert.equal(hallucinated.length, 1);
    assert.ok(Math.abs(hallucinated[0].value - 30) < 0.01);
  });

  it('is fail-open: returns empty when catalog has no prices', () => {
    const empty = buildCatalogPriceSet([]);
    const hallucinated = filterHallucinatedPrices('The product is €30.', empty);
    assert.equal(hallucinated.length, 0);
  });

  it('returns empty when the reply states no price', () => {
    const catalog = buildCatalogPriceSet([{ price: 25, discounted_price: null }]);
    const hallucinated = filterHallucinatedPrices('Available in chocolate.', catalog);
    assert.equal(hallucinated.length, 0);
  });

  it('accepts the discounted price as valid', () => {
    const catalog = buildCatalogPriceSet([{ price: 30, discounted_price: 22 }]);
    const hallucinated = filterHallucinatedPrices('The discounted price is €22.', catalog);
    assert.equal(hallucinated.length, 0);
  });

  it('detects when BOTH a valid and an invalid price are stated', () => {
    const catalog = buildCatalogPriceSet([{ price: 25, discounted_price: null }]);
    const hallucinated = filterHallucinatedPrices('Normal is €25, special is €15.', catalog);
    assert.equal(hallucinated.length, 1);
    assert.ok(Math.abs(hallucinated[0].value - 15) < 0.01);
  });

  it('rounding tolerance: 12.00 matches 12 in catalog', () => {
    const catalog = buildCatalogPriceSet([{ price: 12, discounted_price: null }]);
    const hallucinated = filterHallucinatedPrices('€12.00', catalog);
    assert.equal(hallucinated.length, 0);
  });

  it('price across multiple products: any matching product clears the stated price', () => {
    const catalog = buildCatalogPriceSet([
      { price: 25, discounted_price: null },
      { price: 40, discounted_price: null },
    ]);
    const hallucinated = filterHallucinatedPrices('From €25 to €40.', catalog);
    assert.equal(hallucinated.length, 0);
  });
});

// ---------------------------------------------------------------------------
// replyPricesAreGrounded
// ---------------------------------------------------------------------------

describe('replyPricesAreGrounded', () => {
  it('returns true when all stated prices are in the catalog', () => {
    const catalog = buildCatalogPriceSet([{ price: 25, discounted_price: null }]);
    assert.ok(replyPricesAreGrounded('Price is €25.', catalog));
  });

  it('returns false when a stated price is not in the catalog', () => {
    const catalog = buildCatalogPriceSet([{ price: 25, discounted_price: null }]);
    assert.ok(!replyPricesAreGrounded('Price is €99.', catalog));
  });

  it('returns true when no price is stated', () => {
    const catalog = buildCatalogPriceSet([{ price: 25, discounted_price: null }]);
    assert.ok(replyPricesAreGrounded('We have it in chocolate.', catalog));
  });

  it('returns true (fail-open) when catalog has no prices', () => {
    assert.ok(replyPricesAreGrounded('Price is €30.', buildCatalogPriceSet([])));
  });
});
