/**
 * P3-2 Step 11 (RC-05) — who creates the `ai.reply` job.
 *
 * Two independent booleans govern this, which means four states, and the failure mode is asymmetric:
 * a double-enqueue is a duplicate reply, but a state where NEITHER path enqueues is a stored
 * customer message that is never answered and leaves no error artifact anywhere — RC-21's exact
 * failure mode. So the whole flag space is asserted, not a couple of examples.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  planInboundEnqueue,
  hasExactlyOneEnqueueOwner,
  type InboundEnqueueFlags,
} from '../inboundEnqueuePolicy';

const ALL_FLAG_COMBINATIONS: InboundEnqueueFlags[] = [
  { outboxEnqueue: false, outboxDispatch: false },
  { outboxEnqueue: false, outboxDispatch: true },
  { outboxEnqueue: true, outboxDispatch: false },
  { outboxEnqueue: true, outboxDispatch: true },
];

describe('planInboundEnqueue — the invariant across the whole flag space', () => {
  it('always has exactly one owner of the job', () => {
    // The property that matters. If this ever fails on any cell, either a message is answered twice
    // or — far worse — not at all.
    for (const flags of ALL_FLAG_COMBINATIONS) {
      const plan = planInboundEnqueue(flags);
      assert.equal(
        hasExactlyOneEnqueueOwner(plan),
        true,
        `no single owner for ${JSON.stringify(flags)} → ${JSON.stringify(plan)}`,
      );
    }
  });

  it('never leaves a state where nothing enqueues', () => {
    for (const flags of ALL_FLAG_COMBINATIONS) {
      const plan = planInboundEnqueue(flags);
      const somethingDelivers =
        plan.legacyDirectEnqueue || (plan.owner === 'outbox' && plan.writeOutboxIntent);
      assert.equal(somethingDelivers, true, `silence for ${JSON.stringify(flags)}`);
    }
  });
});

describe('planInboundEnqueue — each cell', () => {
  it('both off: the legacy debounce owns delivery (today’s default)', () => {
    const plan = planInboundEnqueue({ outboxEnqueue: false, outboxDispatch: false });
    assert.deepEqual(plan, {
      writeOutboxIntent: false,
      legacyDirectEnqueue: true,
      owner: 'legacy',
    });
  });

  it('dispatch on but enqueue off: still legacy — there is no intent to dispatch', () => {
    const plan = planInboundEnqueue({ outboxEnqueue: false, outboxDispatch: true });
    assert.equal(plan.writeOutboxIntent, false);
    assert.equal(plan.legacyDirectEnqueue, true);
  });

  it('enqueue on, dispatch off (SHADOW): writes the intent AND keeps the legacy add', () => {
    // The relay shadow-drains the intent without dispatching it, so dropping the legacy add here
    // would mark the intent done without ever creating a job — customer silence, no artifact.
    const plan = planInboundEnqueue({ outboxEnqueue: true, outboxDispatch: false });
    assert.equal(plan.writeOutboxIntent, true);
    assert.equal(plan.legacyDirectEnqueue, true);
    assert.equal(plan.owner, 'legacy');
  });

  it('both on: the outbox owns delivery and the legacy debounce is skipped', () => {
    // This is the state that actually retires RC-05: the racy getJobs/remove/add is replaced by
    // `ON CONFLICT (conversation_id) WHERE topic='ai.reply' AND status='pending' DO UPDATE`,
    // making single-live-intent a database invariant instead of a best-effort scan.
    const plan = planInboundEnqueue({ outboxEnqueue: true, outboxDispatch: true });
    assert.deepEqual(plan, {
      writeOutboxIntent: true,
      legacyDirectEnqueue: false,
      owner: 'outbox',
    });
  });
});

describe('planInboundEnqueue — rollback safety', () => {
  it('turning dispatch off alone restores the legacy path', () => {
    // The documented rollback: flip one flag and delivery returns to the legacy debounce without
    // a deploy, with no window where neither path runs.
    const on = planInboundEnqueue({ outboxEnqueue: true, outboxDispatch: true });
    const rolledBack = planInboundEnqueue({ outboxEnqueue: true, outboxDispatch: false });
    assert.equal(on.legacyDirectEnqueue, false);
    assert.equal(rolledBack.legacyDirectEnqueue, true);
  });

  it('the intent write is a function of one flag only, so shadow mode is independent', () => {
    for (const outboxDispatch of [false, true]) {
      assert.equal(planInboundEnqueue({ outboxEnqueue: true, outboxDispatch }).writeOutboxIntent, true);
      assert.equal(planInboundEnqueue({ outboxEnqueue: false, outboxDispatch }).writeOutboxIntent, false);
    }
  });
});
