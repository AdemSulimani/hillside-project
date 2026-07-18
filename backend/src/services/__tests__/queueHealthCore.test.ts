/**
 * P3-2 Step 5 — queue-health scoring across the two process topologies.
 *
 * The regression this guards is specific: before the split, "is the worker running" was a local
 * Worker fact and always available. In an API-only process it is NOT, and reporting `isRunning:
 * false` there would mark every queue unhealthy on every request even though the worker fleet is
 * perfectly fine. The fallback to `redisWorkersCount` is what keeps the endpoint meaningful.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateQueueHealth,
  normalizeCounts,
  parseDepthThreshold,
  summarize,
  DEFAULT_DEPTH_WARNING,
  type EvaluateQueueInput,
} from '../queueHealthCore';

function baseInput(overrides: Partial<EvaluateQueueInput> = {}): EvaluateQueueInput {
  return {
    key: 'ai',
    label: 'AI replies',
    counts: normalizeCounts({ waiting: 0, active: 0, delayed: 0, paused: 0, completed: 0, failed: 0 }),
    depthThreshold: 100,
    redisWorkersCount: 1,
    local: { concurrency: 5, isRunning: true, isPaused: false },
    ...overrides,
  };
}

describe('evaluateQueueHealth — in-process worker (single-process topology)', () => {
  it('reports local truth and marks the queue in-process', () => {
    const result = evaluateQueueHealth(baseInput());
    assert.equal(result.worker.inProcess, true);
    assert.equal(result.worker.concurrency, 5);
    assert.equal(result.worker.isRunning, true);
    assert.equal(result.healthy, true);
    assert.deepEqual(result.issues, []);
  });

  it('flags a stopped local worker', () => {
    const result = evaluateQueueHealth(
      baseInput({ local: { concurrency: 5, isRunning: false, isPaused: false } }),
    );
    assert.equal(result.healthy, false);
    assert.deepEqual(result.issues, ['worker not running']);
  });

  it('flags a paused local worker', () => {
    const result = evaluateQueueHealth(
      baseInput({ local: { concurrency: 5, isRunning: true, isPaused: true } }),
    );
    assert.equal(result.healthy, false);
    assert.deepEqual(result.issues, ['worker paused']);
  });

  it('trusts local truth over the Redis count', () => {
    // A locally stopped worker is unhealthy even if other hosts are consuming the queue — that is
    // a real fact about this process worth surfacing.
    const result = evaluateQueueHealth(
      baseInput({ redisWorkersCount: 9, local: { concurrency: 5, isRunning: false, isPaused: false } }),
    );
    assert.equal(result.worker.isRunning, false);
    assert.equal(result.healthy, false);
  });
});

describe('evaluateQueueHealth — API-only process (split topology)', () => {
  it('derives liveness from the Redis worker count when no local worker exists', () => {
    const result = evaluateQueueHealth(baseInput({ local: null, redisWorkersCount: 2 }));
    assert.equal(result.worker.inProcess, false);
    assert.equal(result.worker.isRunning, true, 'workers elsewhere still consume this queue');
    assert.equal(result.healthy, true);
  });

  it('reports concurrency as null rather than guessing', () => {
    const result = evaluateQueueHealth(baseInput({ local: null, redisWorkersCount: 2 }));
    assert.equal(result.worker.concurrency, null);
  });

  it('reports isPaused false — a pause is not observable through the registration count', () => {
    const result = evaluateQueueHealth(baseInput({ local: null, redisWorkersCount: 2 }));
    assert.equal(result.worker.isPaused, false);
  });

  it('flags a queue with no workers anywhere, and says so distinctly', () => {
    const result = evaluateQueueHealth(baseInput({ local: null, redisWorkersCount: 0 }));
    assert.equal(result.worker.isRunning, false);
    assert.equal(result.healthy, false);
    assert.deepEqual(
      result.issues,
      ['no workers registered for this queue'],
      'the message must distinguish "nothing consumes this" from "my local worker stopped"',
    );
  });
});

describe('evaluateQueueHealth — depth', () => {
  it('sums waiting + delayed, not active', () => {
    const result = evaluateQueueHealth(
      baseInput({
        counts: normalizeCounts({ waiting: 7, delayed: 5, active: 99 } as Record<string, number>),
      }),
    );
    assert.equal(result.depth, 12);
  });

  it('flags depth strictly above the threshold', () => {
    const at = evaluateQueueHealth(
      baseInput({ counts: normalizeCounts({ waiting: 100 } as Record<string, number>) }),
    );
    assert.equal(at.healthy, true, 'exactly at the threshold is not an issue');

    const over = evaluateQueueHealth(
      baseInput({ counts: normalizeCounts({ waiting: 101 } as Record<string, number>) }),
    );
    assert.equal(over.healthy, false);
    assert.equal(over.issues[0], 'depth 101 exceeds threshold 100');
  });

  it('accumulates depth and worker issues together', () => {
    const result = evaluateQueueHealth(
      baseInput({
        counts: normalizeCounts({ waiting: 500 } as Record<string, number>),
        local: null,
        redisWorkersCount: 0,
      }),
    );
    assert.equal(result.issues.length, 2);
  });
});

describe('parseDepthThreshold', () => {
  it('defaults on absent, empty and unparseable input', () => {
    for (const raw of [undefined, '', 'abc', '0', '-5']) {
      assert.equal(parseDepthThreshold(raw), DEFAULT_DEPTH_WARNING, `input: ${String(raw)}`);
    }
  });

  it('accepts a positive integer', () => {
    assert.equal(parseDepthThreshold('250'), 250);
  });
});

describe('normalizeCounts', () => {
  it('fills every missing bucket with zero', () => {
    assert.deepEqual(normalizeCounts({}), {
      waiting: 0,
      active: 0,
      delayed: 0,
      paused: 0,
      completed: 0,
      failed: 0,
    });
  });
});

describe('summarize', () => {
  it('is unhealthy when any queue is unhealthy', () => {
    const healthy = evaluateQueueHealth(baseInput());
    const broken = evaluateQueueHealth(baseInput({ local: null, redisWorkersCount: 0 }));

    assert.equal(summarize([healthy, healthy], 100).overallHealthy, true);
    assert.equal(summarize([healthy, broken], 100).overallHealthy, false);
    assert.equal(summarize([healthy, broken], 100).overallDegraded, true);
  });
});
