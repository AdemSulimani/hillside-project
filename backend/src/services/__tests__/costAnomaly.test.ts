/**
 * P3-6 — the COGS anomaly detector.
 *
 * The assertion that matters most is the DEFAULT-OFF GUARANTEE: with every threshold at its
 * shipped default (0 / false), a tenant with pathological facts must produce ZERO anomalies. A
 * `measure >= threshold` comparison reads `0` as "fire on everything", which is exactly how a
 * monitoring feature ships as an alert storm on the day it lands.
 *
 * The rest covers hysteresis, which exists because a ratio parked at its threshold would
 * otherwise re-alert on every single tick.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCostAnomalies,
  rearmedKinds,
  type CostAnomalyKind,
  type CostAnomalyThresholds,
  type TenantCostFacts,
} from '../costAnomaly';

const OFF: CostAnomalyThresholds = {
  marginRatio: 0,
  conversationUsd: 0,
  turnCalls: 0,
  modelDrift: false,
};

const facts = (over: Partial<TenantCostFacts> = {}): TenantCostFacts => ({
  tenantId: 't1',
  period: '2026-07',
  usdCost: 10,
  revenue: 100,
  unpricedCalls: 0,
  modelsByRole: { chat: ['gpt-4o'] },
  worstConversation: { conversationId: 'c1', usdCost: 0.5 },
  worstTurn: { conversationId: 'c1', calls: 20 },
  ...over,
});

describe('detectCostAnomalies — the default-off guarantee', () => {
  it('fires nothing at shipped defaults, even on pathological facts', () => {
    const anomalies = detectCostAnomalies(
      facts({
        usdCost: 5000,
        revenue: 1,
        unpricedCalls: 900,
        modelsByRole: { chat: ['gpt-4o', 'gpt-4o-mini'] },
        worstConversation: { conversationId: 'c9', usdCost: 400 },
        worstTurn: { conversationId: 'c9', calls: 5000 },
      }),
      OFF,
    );
    assert.deepEqual(anomalies, [], 'a 0 threshold means OFF, not "fire on everything"');
  });
});

describe('detectCostAnomalies — margin inversion', () => {
  const th = { ...OFF, marginRatio: 0.5 };

  it('fires when COGS reaches the configured share of revenue', () => {
    const [a] = detectCostAnomalies(facts({ usdCost: 50, revenue: 100 }), th);
    assert.equal(a.kind, 'margin_inversion');
    assert.equal(a.measure, 0.5);
  });

  it('does not fire below the ratio', () => {
    assert.deepEqual(detectCostAnomalies(facts({ usdCost: 49, revenue: 100 }), th), []);
  });

  it('reports spend rather than Infinity when a tenant billed nothing', () => {
    // A tenant with cost and zero revenue is the most inverted case there is, so it must fire —
    // but an alert reading "measure: Infinity" is useless to the person triaging it.
    const [a] = detectCostAnomalies(facts({ usdCost: 12, revenue: 0 }), th);
    assert.equal(a.kind, 'margin_inversion');
    assert.equal(a.measure, 12);
    assert.equal(a.detail.zero_revenue, 'yes');
  });

  it('does not fire on a tenant with neither cost nor revenue', () => {
    assert.deepEqual(detectCostAnomalies(facts({ usdCost: 0, revenue: 0 }), th), []);
  });
});

describe('detectCostAnomalies — runaway conversation and turn spikes', () => {
  it('fires on a conversation over the USD threshold', () => {
    const [a] = detectCostAnomalies(
      facts({ worstConversation: { conversationId: 'c9', usdCost: 2 } }),
      { ...OFF, conversationUsd: 1 },
    );
    assert.equal(a.kind, 'runaway_conversation');
    assert.equal(a.detail.conversation_id, 'c9');
  });

  it('fires on a turn call-count spike and names the likely cause', () => {
    // Measured baseline is 18-21 calls/turn, so 40 is the C-126 signature.
    const [a] = detectCostAnomalies(facts({ worstTurn: { conversationId: 'c9', calls: 44 } }), {
      ...OFF,
      turnCalls: 40,
    });
    assert.equal(a.kind, 'turn_call_spike');
    assert.match(String(a.detail.likely_cause), /C-126|retry/);
  });
});

describe('detectCostAnomalies — model drift and unpriced models (RC-17)', () => {
  const th = { ...OFF, modelDrift: true };

  it('fires when one role served two different models in a period', () => {
    const [a] = detectCostAnomalies(
      facts({ modelsByRole: { chat: ['gpt-4o-2024-08-06', 'gpt-4o-mini'] } }),
      th,
    );
    assert.equal(a.kind, 'model_drift');
    assert.equal(a.detail.role, 'chat');
  });

  it('does not fire when every role served exactly one model', () => {
    const out = detectCostAnomalies(
      facts({ modelsByRole: { chat: ['gpt-4o'], classifier: ['gpt-4o-mini'] } }),
      th,
    );
    assert.equal(out.filter((a) => a.kind === 'model_drift').length, 0);
  });

  it('fires on an unpriced model and states which way the number is wrong', () => {
    const [a] = detectCostAnomalies(facts({ unpricedCalls: 3 }), th);
    assert.equal(a.kind, 'unpriced_model');
    // The direction is the whole point: an unpriced call is counted but costs 0, so reported
    // COGS drifts DOWNWARD — a config bug that reads as a cost improvement.
    assert.match(String(a.detail.impact), /understates/);
  });
});

describe('hysteresis', () => {
  const th = { ...OFF, marginRatio: 0.5 };

  it('does not re-fire while a kind is already tripped', () => {
    const tripped = new Set<CostAnomalyKind>(['margin_inversion']);
    assert.deepEqual(detectCostAnomalies(facts({ usdCost: 90, revenue: 100 }), th, tripped), []);
  });

  it('re-arms only once the measure falls below threshold x rearmFactor', () => {
    const tripped = new Set<CostAnomalyKind>(['margin_inversion']);
    // 0.48 is under the 0.5 threshold but NOT under 0.5 * 0.9 = 0.45 — still latched, which is
    // what stops a measure parked at the boundary from alerting every tick.
    assert.deepEqual(rearmedKinds(facts({ usdCost: 48, revenue: 100 }), th, tripped, 0.9), []);
    assert.deepEqual(rearmedKinds(facts({ usdCost: 40, revenue: 100 }), th, tripped, 0.9), [
      'margin_inversion',
    ]);
  });

  it('re-arms an unpriced-model alert only when every call is priced again', () => {
    const tripped = new Set<CostAnomalyKind>(['unpriced_model']);
    assert.deepEqual(rearmedKinds(facts({ unpricedCalls: 1 }), { ...OFF, modelDrift: true }, tripped), []);
    assert.deepEqual(rearmedKinds(facts({ unpricedCalls: 0 }), { ...OFF, modelDrift: true }, tripped), [
      'unpriced_model',
    ]);
  });

  it('fires again after a re-arm', () => {
    const tripped = new Set<CostAnomalyKind>(['margin_inversion']);
    for (const kind of rearmedKinds(facts({ usdCost: 10, revenue: 100 }), th, tripped)) {
      tripped.delete(kind);
    }
    const [a] = detectCostAnomalies(facts({ usdCost: 80, revenue: 100 }), th, tripped);
    assert.equal(a.kind, 'margin_inversion');
  });
});
