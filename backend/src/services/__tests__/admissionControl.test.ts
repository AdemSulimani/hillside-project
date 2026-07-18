/**
 * P3-2 Step 9 (C-79 / RC-18) — bounded admission control.
 *
 * The behaviour under test is the fix for a retry amplifier: the legacy gate re-added a starved job
 * every 3 s with no jobId and no hop counter, so N starved jobs became N new jobs per tick, forever,
 * each with `attemptsMade` reset to 0.
 *
 * `decideAdmission` is deliberately pure — jitter is an injected 0..1 sample and delays are relative
 * — so every case here runs with no clock, no randomness and no Redis.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAdmission,
  admissionDelayMs,
  admissionJobId,
  normalizeHop,
  AdmissionShedError,
  ADMISSION_SHED_ERROR_NAME,
  DEFAULT_ADMISSION_POLICY,
  type AdmissionPolicy,
} from '../../jobs/admissionControl';

const POLICY: AdmissionPolicy = {
  baseDelayMs: 3_000,
  maxDelayMs: 60_000,
  maxHops: 8,
  jitterRatio: 0.2,
};

/** No jitter, so delay assertions are exact. */
const NO_JITTER = 0;

describe('normalizeHop', () => {
  it('treats an absent hop as the first attempt', () => {
    // Every job enqueued before this shipped, and every first delivery, lacks the field.
    assert.equal(normalizeHop(undefined), 0);
  });

  it('rejects garbage rather than propagating it', () => {
    // The value round-trips through Postgres JSONB on the outbox path.
    assert.equal(normalizeHop(Number.NaN), 0);
    assert.equal(normalizeHop(-3), 0);
    assert.equal(normalizeHop(Number.POSITIVE_INFINITY), 0);
    assert.equal(normalizeHop(2.7), 2);
  });
});

describe('admissionDelayMs', () => {
  it('doubles per hop', () => {
    assert.equal(admissionDelayMs(0, NO_JITTER, POLICY), 3_000);
    assert.equal(admissionDelayMs(1, NO_JITTER, POLICY), 6_000);
    assert.equal(admissionDelayMs(2, NO_JITTER, POLICY), 12_000);
    assert.equal(admissionDelayMs(3, NO_JITTER, POLICY), 24_000);
    assert.equal(admissionDelayMs(4, NO_JITTER, POLICY), 48_000);
  });

  it('caps at maxDelayMs', () => {
    assert.equal(admissionDelayMs(5, NO_JITTER, POLICY), 60_000);
    assert.equal(admissionDelayMs(50, NO_JITTER, POLICY), 60_000);
  });

  it('never overflows to Infinity on an absurd hop', () => {
    const delay = admissionDelayMs(10_000, NO_JITTER, POLICY);
    assert.ok(Number.isFinite(delay));
    assert.equal(delay, 60_000);
  });

  it('jitters downward only, so the cap is never exceeded', () => {
    // Upward jitter would make maxDelayMs a lie. The herd-breaking property only needs spread.
    for (const sample of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = admissionDelayMs(9, sample, POLICY);
      assert.ok(delay <= POLICY.maxDelayMs, `sample ${sample} exceeded the cap`);
      assert.ok(delay >= POLICY.maxDelayMs * (1 - POLICY.jitterRatio) - 1);
    }
  });

  it('spreads a herd: identical hops with different samples do not collide', () => {
    const a = admissionDelayMs(2, 0, POLICY);
    const b = admissionDelayMs(2, 1, POLICY);
    assert.notEqual(a, b);
    assert.equal(a, 12_000);
    assert.equal(b, 9_600); // 12000 * (1 - 0.2)
  });

  it('is monotonic in hop for a fixed sample', () => {
    let previous = -1;
    for (let hop = 0; hop < 6; hop += 1) {
      const delay = admissionDelayMs(hop, 0.5, POLICY);
      assert.ok(delay >= previous, `hop ${hop} went backwards`);
      previous = delay;
    }
  });

  it('clamps an out-of-range jitter sample instead of producing a negative delay', () => {
    assert.ok(admissionDelayMs(1, -5, POLICY) >= 0);
    assert.ok(admissionDelayMs(1, 99, POLICY) >= 0);
    assert.ok(admissionDelayMs(1, Number.NaN, POLICY) >= 0);
  });
});

describe('decideAdmission', () => {
  it('defers a first-time job and advances the hop', () => {
    const decision = decideAdmission({
      hop: undefined,
      gate: 'tenant_capacity',
      jitter: NO_JITTER,
      policy: POLICY,
    });
    assert.equal(decision.action, 'defer');
    assert.equal(decision.action === 'defer' && decision.nextHop, 1);
    assert.equal(decision.action === 'defer' && decision.delayMs, 3_000);
  });

  it('sheds once the hop budget is reached', () => {
    const decision = decideAdmission({
      hop: POLICY.maxHops,
      gate: 'tenant_capacity',
      jitter: NO_JITTER,
      policy: POLICY,
    });
    assert.equal(decision.action, 'shed');
    assert.equal(decision.action === 'shed' && decision.hops, POLICY.maxHops);
  });

  it('defers on the last hop before the budget, not one early', () => {
    const decision = decideAdmission({
      hop: POLICY.maxHops - 1,
      gate: 'conversation_busy',
      jitter: NO_JITTER,
      policy: POLICY,
    });
    assert.equal(decision.action, 'defer');
  });

  it('names the gate in the shed reason so the alert is diagnosable', () => {
    const decision = decideAdmission({
      hop: 99,
      gate: 'conversation_busy',
      jitter: NO_JITTER,
      policy: POLICY,
    });
    assert.equal(decision.action, 'shed');
    assert.ok(decision.action === 'shed' && decision.reason.includes('conversation_busy'));
    assert.ok(decision.action === 'shed' && decision.reason.includes('99'));
  });

  it('terminates: repeated deferral always reaches a shed', () => {
    // The property the legacy path lacked entirely — it could defer forever.
    let hop: number | undefined;
    let iterations = 0;
    for (;;) {
      const decision = decideAdmission({
        hop,
        gate: 'tenant_capacity',
        jitter: NO_JITTER,
        policy: POLICY,
      });
      if (decision.action === 'shed') break;
      hop = decision.nextHop;
      iterations += 1;
      assert.ok(iterations <= POLICY.maxHops, 'deferral did not terminate');
    }
    assert.equal(iterations, POLICY.maxHops);
  });

  it('uses the default policy when none is supplied', () => {
    const decision = decideAdmission({ hop: 0, gate: 'tenant_capacity', jitter: NO_JITTER });
    assert.equal(decision.action, 'defer');
    assert.equal(
      decision.action === 'defer' && decision.delayMs,
      DEFAULT_ADMISSION_POLICY.baseDelayMs,
    );
  });
});

describe('admissionJobId', () => {
  it('collapses concurrent deferrals of the same inbound at the same hop', () => {
    // THE fix for C-79: BullMQ ignores an add whose jobId already exists, so two workers deferring
    // the same inbound produce one job instead of two.
    assert.equal(admissionJobId('conv-1', 'msg-1', 1), admissionJobId('conv-1', 'msg-1', 1));
  });

  it('distinguishes the next hop from the current one', () => {
    // Without the hop in the key, a job that ran and deferred again would be silently dropped as a
    // duplicate of itself — turning a deferral into a lost message.
    assert.notEqual(admissionJobId('conv-1', 'msg-1', 1), admissionJobId('conv-1', 'msg-1', 2));
  });

  it('distinguishes conversations and inbound messages', () => {
    assert.notEqual(admissionJobId('conv-1', 'msg-1', 1), admissionJobId('conv-2', 'msg-1', 1));
    assert.notEqual(admissionJobId('conv-1', 'msg-1', 1), admissionJobId('conv-1', 'msg-2', 1));
  });
});

describe('AdmissionShedError', () => {
  it('carries the name the failure classifier matches on', () => {
    // A shed must reach `worker.on('failed')`. A bare return would be a SUCCESSFUL job — no
    // dead_letter row, no Sentry, no ai_reply_undelivered alert, and a silently dropped message.
    const err = new AdmissionShedError('admission_shed:tenant_capacity:hops=8', 8, 'tenant_capacity');
    assert.equal(err.name, ADMISSION_SHED_ERROR_NAME);
    assert.ok(err instanceof Error);
    assert.equal(err.hops, 8);
    assert.equal(err.gate, 'tenant_capacity');
  });
});
