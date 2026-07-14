/**
 * Tests for the RC-22 commission-window query builder (P2-2, Slice B5).
 *
 * The anchoring change must be deterministic and flag-gated: flag-off reproduces the legacy
 * NOW()-relative query (3 params, no upper bound); flag-on anchors on the stored consent timestamp
 * ($4) and bounds the window at it. Pure — no DB.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommissionWindowQuery } from '../commissionWindow';

const BASE = { conversationId: 'c1', tenantId: 't1', sessionGapHours: 3 };
const ORDER_AT = new Date('2026-07-14T10:00:00.000Z');

describe('buildCommissionWindowQuery', () => {
  it('flag-off: uses NOW(), exactly 3 params, no upper bound', () => {
    const q = buildCommissionWindowQuery({ ...BASE, orderEventAt: ORDER_AT, anchorOnOrderEvent: false });
    assert.equal(q.values.length, 3);
    assert.deepEqual(q.values, ['c1', 't1', 3]);
    assert.ok(q.text.includes("NOW() - INTERVAL '30 days'"));
    assert.ok(!q.text.includes('$4'));
    assert.ok(!q.text.includes('created_at <='));
  });

  it('flag-on with a timestamp: anchors on $4 and bounds recent_messages at it', () => {
    const q = buildCommissionWindowQuery({ ...BASE, orderEventAt: ORDER_AT, anchorOnOrderEvent: true });
    assert.equal(q.values.length, 4);
    assert.equal(q.values[3], ORDER_AT);
    assert.ok(q.text.includes("$4::timestamptz - INTERVAL '30 days'"));
    assert.ok(q.text.includes('AND created_at <= $4::timestamptz'));
    assert.ok(!q.text.includes('NOW()'));
  });

  it('flag-on but no timestamp: falls back to the legacy NOW() query (3 params)', () => {
    const q = buildCommissionWindowQuery({ ...BASE, orderEventAt: null, anchorOnOrderEvent: true });
    assert.equal(q.values.length, 3);
    assert.ok(q.text.includes('NOW()'));
    assert.ok(!q.text.includes('$4'));
  });

  it('is deterministic: identical args -> identical text + values (no wall-clock in the builder)', () => {
    const a = buildCommissionWindowQuery({ ...BASE, orderEventAt: ORDER_AT, anchorOnOrderEvent: true });
    const b = buildCommissionWindowQuery({ ...BASE, orderEventAt: ORDER_AT, anchorOnOrderEvent: true });
    assert.equal(a.text, b.text);
    assert.deepEqual(a.values, b.values);
  });
});
