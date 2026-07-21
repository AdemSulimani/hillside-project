/**
 * Tests for the multi-product extension of the purchase-intent payload mapper (migration 088).
 *
 * `mapIntentPayload` gained an `items[]` basket while the scalar product_name/quantity stayed the
 * PRIMARY-product mirror so every existing scalar reader keeps working. These cover: the multi-item
 * parse, scalar derivation from items[0], the backward-compat synth of items from the scalar (the
 * legacy/flag-off prompt AND cached pre-088 verdicts), per-item quantity coercion, and nameless-item
 * drop. Pure/in-process — no OpenAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mapIntentPayload } from '../intentPayload';

describe('mapIntentPayload — multi-product items[]', () => {
  it('parses multiple items and mirrors the scalars from the primary (first) item', () => {
    const out = mapIntentPayload({
      intent_score: 0.9,
      product_name: 'Protein',
      quantity: 1,
      items: [
        { product_name: 'Protein', quantity: 1 },
        { product_name: 'Creatine', quantity: 2 },
      ],
      is_ready_to_order: true,
    });
    assert.equal(out.items.length, 2);
    assert.deepEqual(out.items, [
      { product_name: 'Protein', quantity: 1 },
      { product_name: 'Creatine', quantity: 2 },
    ]);
    assert.equal(out.product_name, 'Protein');
    assert.equal(out.quantity, 1);
  });

  it('derives the scalar product_name/quantity from items[0] even when the scalar fields disagree', () => {
    const out = mapIntentPayload({
      intent_score: 0.9,
      product_name: 'Stale',
      quantity: 9,
      items: [{ product_name: 'Creatine', quantity: 3 }],
    });
    assert.equal(out.product_name, 'Creatine');
    assert.equal(out.quantity, 3);
  });

  it('synthesizes a single item from the scalar when items is absent (legacy/flag-off + cached verdicts)', () => {
    const out = mapIntentPayload({
      intent_score: 0.8,
      product_name: 'Protein',
      quantity: 2,
      // no `items` key — a pre-088 payload
    });
    assert.deepEqual(out.items, [{ product_name: 'Protein', quantity: 2 }]);
    assert.equal(out.product_name, 'Protein');
  });

  it('synthesizes a single item from the scalar when items is present but empty', () => {
    const out = mapIntentPayload({
      intent_score: 0.8,
      product_name: 'Protein',
      quantity: null,
      items: [],
    });
    assert.deepEqual(out.items, [{ product_name: 'Protein', quantity: null }]);
  });

  it('drops nameless / whitespace-only items and coerces bad quantities', () => {
    const out = mapIntentPayload({
      intent_score: 0.9,
      product_name: 'Protein',
      quantity: 1,
      items: [
        { product_name: 'Protein', quantity: 2.9 }, // floored to 2
        { product_name: '   ', quantity: 1 }, // dropped (empty name)
        { product_name: 'Creatine', quantity: 0 }, // kept, quantity -> null (not positive)
        { product_name: 'BCAA', quantity: -4 }, // kept, quantity -> null
        { quantity: 5 }, // dropped (no name)
      ],
    });
    assert.deepEqual(out.items, [
      { product_name: 'Protein', quantity: 2 },
      { product_name: 'Creatine', quantity: null },
      { product_name: 'BCAA', quantity: null },
    ]);
    // Primary mirror follows items[0].
    assert.equal(out.product_name, 'Protein');
    assert.equal(out.quantity, 2);
  });

  it('yields empty items and null scalar when no product is named at all', () => {
    const out = mapIntentPayload({
      intent_score: 0.2,
      product_name: null,
      quantity: null,
      is_ready_to_order: false,
    });
    assert.deepEqual(out.items, []);
    assert.equal(out.product_name, null);
    assert.equal(out.quantity, null);
  });

  it('preserves the legacy intent_score coercion (>1 is treated as a percentage)', () => {
    const out = mapIntentPayload({
      intent_score: 90,
      product_name: 'Protein',
      quantity: 1,
      items: [{ product_name: 'Protein', quantity: 1 }],
    });
    assert.equal(out.intent_score, 0.9);
  });

  // The order tail re-normalizes EVERY purchase-intent verdict through mapIntentPayload because
  // classifierVerdictStore returns a cached hit as JSON.parse verbatim — a verdict cached before
  // the items[] deploy has no `items` key and would crash `intent.items.length`. That re-map is
  // only sound if mapping an already-mapped result is the identity.
  it('is idempotent: mapping an already-mapped result returns a deep-equal result', () => {
    const raws: Record<string, unknown>[] = [
      {
        intent_score: 0.9,
        product_name: 'Protein',
        quantity: 1,
        items: [
          { product_name: 'Protein', quantity: 1 },
          { product_name: 'Creatine', quantity: 2 },
        ],
        delivery_address: ' Rr. Dëshmorët 12, Prishtinë ',
        customer_first_name: 'Arta',
        is_ready_to_order: true,
        reasoning: 'ordered two products',
      },
      { intent_score: 87, product_name: 'Protein', quantity: 2 }, // pre-088 cached shape
      { intent_score: 0.2 }, // minimal
    ];
    for (const raw of raws) {
      const once = mapIntentPayload(raw);
      const twice = mapIntentPayload(once as unknown as Record<string, unknown>);
      assert.deepEqual(twice, once);
    }
  });

  it('degrades a pre-088 cached verdict blob (no items key) to the scalar-synth single line', () => {
    // Exactly what JSON.parse of a pre-deploy classifierVerdictStore entry looks like.
    const cachedBlob = {
      intent_score: 0.91,
      product_name: 'Iso Protein Pro',
      quantity: 2,
      delivery_address: 'Prishtinë',
      customer_first_name: 'Arta',
      is_ready_to_order: true,
      reasoning: 'cached before items[] existed',
    };
    const out = mapIntentPayload(cachedBlob);
    assert.deepEqual(out.items, [{ product_name: 'Iso Protein Pro', quantity: 2 }]);
    assert.equal(out.intent_score, 0.91);
    assert.equal(out.is_ready_to_order, true);
  });
});
