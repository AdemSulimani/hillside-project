/**
 * P3-2 Step 5 — worker concurrency parsing.
 *
 * This replaced a local `envInt` in `workers.ts`. Every case below asserts the OLD semantics
 * byte-for-byte, because a silent change here alters how much work each process does — including
 * the case that looks like a bug: `'0'` falls back to the default rather than disabling the worker.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWorkerConcurrency,
  WORKER_CONCURRENCY_DEFAULTS,
} from '../../jobs/workerConcurrency';

describe('resolveWorkerConcurrency', () => {
  it('uses the documented default when unset', () => {
    assert.equal(resolveWorkerConcurrency('AI_WORKER_CONCURRENCY', {}), 5);
    assert.equal(resolveWorkerConcurrency('WEBHOOK_WORKER_CONCURRENCY', {}), 10);
    assert.equal(resolveWorkerConcurrency('NOTIFICATIONS_WORKER_CONCURRENCY', {}), 3);
    assert.equal(resolveWorkerConcurrency('FINETUNING_WORKER_CONCURRENCY', {}), 1);
    assert.equal(resolveWorkerConcurrency('DEFAULT_WORKER_CONCURRENCY', {}), 3);
  });

  it('reads a valid override', () => {
    assert.equal(resolveWorkerConcurrency('AI_WORKER_CONCURRENCY', { AI_WORKER_CONCURRENCY: '2' }), 2);
  });

  it('falls back on empty, unparseable, zero and negative — the legacy envInt semantics', () => {
    for (const raw of ['', 'abc', '0', '-1']) {
      assert.equal(
        resolveWorkerConcurrency('AI_WORKER_CONCURRENCY', { AI_WORKER_CONCURRENCY: raw }),
        5,
        `input: '${raw}'`,
      );
    }
  });

  it("does NOT treat '0' as 'disable this worker'", () => {
    // It never did. A host that set 0 expecting a disabled worker has been running at the default
    // all along; changing that here would silently stop a queue on that host. Disabling a class of
    // work is PROCESS_ROLE's job.
    assert.equal(
      resolveWorkerConcurrency('DEFAULT_WORKER_CONCURRENCY', { DEFAULT_WORKER_CONCURRENCY: '0' }),
      WORKER_CONCURRENCY_DEFAULTS.DEFAULT_WORKER_CONCURRENCY,
    );
  });

  it('parses a leading integer the way parseInt does', () => {
    assert.equal(resolveWorkerConcurrency('AI_WORKER_CONCURRENCY', { AI_WORKER_CONCURRENCY: '4x' }), 4);
  });

  it('reads process.env by default', () => {
    const original = process.env.AI_WORKER_CONCURRENCY;
    process.env.AI_WORKER_CONCURRENCY = '7';
    try {
      assert.equal(resolveWorkerConcurrency('AI_WORKER_CONCURRENCY'), 7);
    } finally {
      if (original === undefined) delete process.env.AI_WORKER_CONCURRENCY;
      else process.env.AI_WORKER_CONCURRENCY = original;
    }
  });
});
