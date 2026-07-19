/**
 * P3-2 load-shaped acceptance, scaled to CI: the two claims the remediation plan states for the
 * worker fleet, proven on real Redis (and real BullMQ for the second).
 *
 *   1. FAIRNESS — "a noisy tenant burst must not starve others." The per-tenant slot lease is a
 *      sorted set per tenant, so tenant A's backlog CANNOT consume tenant B's slots. Simulated in
 *      rounds through the production Lua scripts: a 40-contender noisy tenant next to a
 *      5-contender quiet tenant, cap 2 each — the quiet tenant must finish in exactly
 *      ceil(5/2) = 3 rounds, byte-independent of the noisy backlog, and the noisy tenant must
 *      never hold more than its cap concurrently.
 *
 *   2. ZERO-DROP DRAIN — "a rolling deploy drops zero in-flight jobs." At the queue layer a
 *      rolling deploy IS a graceful `worker.close()` mid-stream followed by a fresh worker
 *      (`worker.ts` wires SIGTERM to exactly that). 100 jobs, close the first worker mid-drain,
 *      start a second: every job processed exactly once, none lost, none duplicated.
 *
 * The full-scale version of (1) with latency percentiles is the manual harness:
 * `npm run loadtest:fairness` (src/loadtest/fairnessHarness.ts).
 *
 * Run with `npm run test:integration` (needs REDIS_URL, default the dev Redis).
 */
import 'dotenv/config';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import IORedis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import { createRedisTestClient } from './redisTestClient';
import {
  TENANT_SLOT_ACQUIRE_SCRIPT,
  TENANT_SLOT_RELEASE_SCRIPT,
  parseAcquireResult,
  tenantSlotKey,
  tenantSlotMember,
} from '../services/tenantSlotLease';

const redis = createRedisTestClient();
const SLOT_TTL_MS = 60_000;

after(async () => {
  redis.disconnect();
});

async function tryAcquire(tenant: string, contender: string, maxN: number): Promise<boolean> {
  const raw = await redis.eval(
    TENANT_SLOT_ACQUIRE_SCRIPT,
    1,
    tenantSlotKey(tenant),
    Date.now(),
    SLOT_TTL_MS,
    tenantSlotMember(contender, 'tok'),
    maxN,
  );
  return parseAcquireResult(raw).acquired;
}

async function release(tenant: string, contender: string): Promise<void> {
  await redis.eval(
    TENANT_SLOT_RELEASE_SCRIPT,
    1,
    tenantSlotKey(tenant),
    tenantSlotMember(contender, 'tok'),
  );
}

describe('P3-2 fairness: a noisy tenant cannot starve a quiet one (real Redis, production Lua)', () => {
  it('quiet tenant completes in ceil(n/cap) rounds regardless of a 8x noisy backlog', async () => {
    const noisy = `noisy-${crypto.randomUUID()}`;
    const quiet = `quiet-${crypto.randomUUID()}`;
    const CAP = 2;
    const pending = new Map<string, string[]>([
      [noisy, Array.from({ length: 40 }, (_, i) => `n-${i}`)],
      [quiet, Array.from({ length: 5 }, (_, i) => `q-${i}`)],
    ]);

    let quietDoneAtRound: number | null = null;
    let noisyMaxConcurrent = 0;

    for (let round = 1; round <= 30; round++) {
      const admitted: Array<[string, string]> = [];
      for (const [tenant, contenders] of pending) {
        // Every still-pending contender races for its tenant's slots this round (the deferred
        // ones model BullMQ's delayed re-adds — admissionControl collapses them by jobId).
        for (const c of [...contenders]) {
          if (await tryAcquire(tenant, c, CAP)) {
            admitted.push([tenant, c]);
            contenders.splice(contenders.indexOf(c), 1);
          }
        }
      }
      noisyMaxConcurrent = Math.max(
        noisyMaxConcurrent,
        admitted.filter(([t]) => t === noisy).length,
      );
      // "Jobs" complete; release the slots for the next round.
      for (const [tenant, c] of admitted) await release(tenant, c);

      if (quietDoneAtRound === null && pending.get(quiet)!.length === 0) quietDoneAtRound = round;
      if ([...pending.values()].every((p) => p.length === 0)) break;
    }

    assert.equal(
      quietDoneAtRound,
      3,
      'ceil(5/2) = 3 rounds — one more means the noisy backlog leaked into the quiet tenant\'s slots',
    );
    assert.ok(
      noisyMaxConcurrent <= CAP,
      `noisy tenant held ${noisyMaxConcurrent} concurrent slots, cap ${CAP}`,
    );
    assert.deepEqual(
      [...pending.values()].map((p) => p.length),
      [0, 0],
      'every contender of both tenants eventually ran — bounded fairness, not starvation-by-cap',
    );
    await redis.del(tenantSlotKey(noisy), tenantSlotKey(quiet));
  });
});

describe('P3-2 zero-drop drain: graceful worker.close() mid-stream loses nothing (real BullMQ)', () => {
  const queueName = `drain-test-${process.pid}`;
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  // BullMQ requires maxRetriesPerRequest: null on its blocking connections — and it never closes
  // a caller-PROVIDED ioredis instance (queue.close()/worker.close() only release connections
  // BullMQ created itself), so every instance is tracked and disconnected in the finally below
  // or the test process never exits.
  const conns: IORedis[] = [];
  const mkConn = () => {
    const c = new IORedis(url, { maxRetriesPerRequest: null });
    conns.push(c);
    return c;
  };

  it('100 jobs, worker swapped mid-drain: each processed exactly once', async () => {
    const queue = new Queue(queueName, { connection: mkConn() });
    const processed: string[] = [];
    const mkWorker = () =>
      new Worker(
        queueName,
        async (job) => {
          await new Promise((r) => setTimeout(r, 20));
          processed.push(String(job.id));
        },
        { connection: mkConn(), concurrency: 5 },
      );

    try {
      await queue.addBulk(
        Array.from({ length: 100 }, (_, i) => ({
          name: 'drain',
          data: { i },
          opts: { jobId: `d-${i}` },
        })),
      );

      const first = mkWorker();
      // Let the first worker get genuinely mid-drain (some done, some in flight)...
      while (processed.length < 15) await new Promise((r) => setTimeout(r, 25));
      // ...then the "rolling deploy": graceful close — finishes in-flight jobs, takes no new ones.
      await first.close();
      const afterClose = processed.length;
      assert.ok(afterClose < 100, `first worker drained everything (${afterClose}) before the swap`);

      const second = mkWorker();
      const deadline = Date.now() + 30_000;
      while (processed.length < 100 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await second.close();

      assert.equal(processed.length, 100, `processed ${processed.length}/100 — jobs were dropped`);
      assert.equal(
        new Set(processed).size,
        100,
        'duplicate processing — the graceful close abandoned an in-flight job that was then retried',
      );
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      for (const c of conns) c.disconnect();
    }
  });
});
