/**
 * Tests for the pure order-line assembler (migration 088, multi-product orders).
 *
 * Covers the edge cases locked in the remediation plan: distinct variants become separate lines,
 * the same product merges (summed quantity), out-of-stock / unmatched / ambiguous items are skipped
 * per line (the rest still assemble), an all-skipped input yields no lines, the order total is the
 * sum of line totals, and each line is priced at the BASE catalog price (the 2026-07-21 decision:
 * the AI quotes base price by default; discounts are negotiation-only and unobservable here).
 * All pure/in-process — no DB/OpenAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleOrderLines,
  effectivePrice,
  type AssemblyInputItem,
} from '../orderLineAssembly';
import type { Product } from '../../db/models/product';
import type { OrderProductResolution } from '../orderProductResolutionService';

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: 'p1',
    tenant_id: 't1',
    name: 'Protein',
    brand: null,
    price: 10,
    discounted_price: null,
    description: null,
    usage_description: null,
    sku: null,
    category: null,
    tags: [],
    flavor: null,
    size: null,
    color: null,
    variant: null,
    weight: null,
    image_urls: [],
    is_active: true,
    in_stock: true,
    source_type: 'manual',
    extracted_text: null,
    metadata: null,
    deleted_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...overrides,
  };
}

const resolved = (p: Product): OrderProductResolution => ({
  product: p,
  ambiguous: false,
  reason: 'unique',
  candidates: [p],
});
const ambiguousOf = (candidates: Product[]): OrderProductResolution => ({
  product: null,
  ambiguous: true,
  reason: 'ambiguous',
  candidates,
});
const noMatch = (): OrderProductResolution => ({
  product: null,
  ambiguous: false,
  reason: 'no_candidates',
  candidates: [],
});
const input = (resolution: OrderProductResolution, qty: number | null): AssemblyInputItem => ({
  resolution,
  requestedQuantity: qty,
});

describe('assembleOrderLines', () => {
  it('turns two distinct products into two lines and sums the total', () => {
    const protein = product({ id: 'a', name: 'Protein', price: 20 });
    const creatine = product({ id: 'b', name: 'Creatine', price: 15 });
    const out = assembleOrderLines([input(resolved(protein), 1), input(resolved(creatine), 2)]);

    assert.equal(out.lines.length, 2);
    assert.deepEqual(
      out.lines.map((l) => [l.product_id, l.quantity, l.unit_price, l.total_price]),
      [
        ['a', 1, 20, 20],
        ['b', 2, 15, 30],
      ],
    );
    assert.equal(out.orderTotal, 50);
    assert.deepEqual(out.resolvedNames, ['Protein', 'Creatine']);
  });

  it('merges the same product ordered twice into one line with summed quantity', () => {
    const protein = product({ id: 'a', name: 'Protein', price: 10 });
    const out = assembleOrderLines([input(resolved(protein), 1), input(resolved(protein), 3)]);

    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0].quantity, 4);
    assert.equal(out.lines[0].total_price, 40);
    assert.equal(out.orderTotal, 40);
  });

  it('skips an out-of-stock line but still registers the rest', () => {
    const inStock = product({ id: 'a', name: 'Protein', price: 10 });
    const oos = product({ id: 'b', name: 'Creatine', price: 15, in_stock: false });
    const out = assembleOrderLines([input(resolved(inStock), 1), input(resolved(oos), 1)]);

    assert.equal(out.lines.length, 1);
    assert.equal(out.lines[0].product_id, 'a');
    assert.equal(out.outOfStock.length, 1);
    assert.equal(out.outOfStock[0].productName, 'Creatine');
    assert.equal(out.orderTotal, 10);
  });

  it('buckets ambiguous and unmatched items and never lets them become lines', () => {
    const good = product({ id: 'a', name: 'Protein', price: 10 });
    const v1 = product({ id: 'x', name: 'Creatine 50' });
    const v2 = product({ id: 'y', name: 'Creatine 60' });
    const out = assembleOrderLines([
      input(resolved(good), 1),
      input(ambiguousOf([v1, v2]), 1),
      input(noMatch(), 1),
    ]);

    assert.equal(out.lines.length, 1);
    assert.equal(out.ambiguous.length, 1);
    assert.deepEqual(out.ambiguous[0].candidates.map((c) => c.id), ['x', 'y']);
    assert.equal(out.unmatched.length, 1);
    assert.equal(out.orderTotal, 10);
  });

  it('produces no lines and a zero total when every item is skipped', () => {
    const v1 = product({ id: 'x' });
    const out = assembleOrderLines([input(ambiguousOf([v1]), 1), input(noMatch(), 2)]);

    assert.equal(out.lines.length, 0);
    assert.equal(out.orderTotal, 0);
    assert.deepEqual(out.resolvedNames, []);
  });

  it('defaults a null/absent quantity to 1 per line', () => {
    const p = product({ id: 'a', price: 12 });
    const out = assembleOrderLines([input(resolved(p), null)]);
    assert.equal(out.lines[0].quantity, 1);
    assert.equal(out.lines[0].total_price, 12);
  });

  it('prices each line at the base catalog price, ignoring discounted_price', () => {
    const discounted = product({ id: 'a', price: 30, discounted_price: 20 });
    assert.equal(effectivePrice(discounted), 30);
    const out = assembleOrderLines([input(resolved(discounted), 2)]);
    assert.equal(out.lines[0].unit_price, 30);
    assert.equal(out.lines[0].total_price, 60);
  });

  it('rounds line and order totals to 2dp', () => {
    const p = product({ id: 'a', price: 9.99 });
    const out = assembleOrderLines([input(resolved(p), 3)]);
    assert.equal(out.lines[0].total_price, 29.97);
    assert.equal(out.orderTotal, 29.97);
  });
});
