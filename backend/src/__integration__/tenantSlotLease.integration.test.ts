/**
 * P3-2 Step 9a — the tenant slot lease Lua, against a REAL Redis.
 *
 * The properties under test are the ones the replaced counter could not hold. The counter
 * (`INCR` + a single un-refreshed `EXPIRE`) went NEGATIVE and TTL-less once its key expired
 * mid-flight, silently disabling the fairness cap for exactly the burst-traffic tenant it exists to
 * contain. A lease per job cannot do that, and only a real Redis can demonstrate it — the atomicity
 * and the expiry are properties of the server, not of the script text.
 *
 * Requires a reachable Redis. Run with `npm run test:integration`.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type IORedis from 'ioredis';
import { createRedisTestClient } from './redisTestClient';
import {
  TENANT_SLOT_ACQUIRE_SCRIPT,
  TENANT_SLOT_RELEASE_SCRIPT,
  tenantSlotKey,
  tenantSlotMember,
  parseAcquireResult,
} from '../services/tenantSlotLease';

const TENANT = 'p3-2-slot-test-tenant';
const KEY = tenantSlotKey(TENANT);

let redis: IORedis;

async function acquire(member: string, max: number, ttlMs = 5_000, now = Date.now()) {
  const raw = await redis.eval(
    TENANT_SLOT_ACQUIRE_SCRIPT,
    1,
    KEY,
    String(now),
    String(ttlMs),
    member,
    String(max),
  );
  return parseAcquireResult(raw);
}

async function release(member: string): Promise<number> {
  return (await redis.eval(TENANT_SLOT_RELEASE_SCRIPT, 1, KEY, member)) as number;
}

before(async () => {
  redis = createRedisTestClient();
  await redis.connect();
});

after(async () => {
  await redis.del(KEY).catch(() => undefined);
  await redis.quit().catch(() => undefined);
});

beforeEach(async () => {
  await redis.del(KEY);
});

describe('tenant slot lease — capacity', () => {
  it('admits exactly `max` concurrent holders and refuses the next', async () => {
    const max = 3;
    for (let i = 0; i < max; i += 1) {
      const result = await acquire(tenantSlotMember(`conv-${i}`, `tok-${i}`), max);
      assert.equal(result.acquired, true, `holder ${i} should have been admitted`);
      assert.equal(result.active, i + 1);
    }

    const overflow = await acquire(tenantSlotMember('conv-x', 'tok-x'), max);
    assert.equal(overflow.acquired, false);
    assert.equal(overflow.active, max, 'a refusal must not add a member');
    assert.equal(await redis.zcard(KEY), max);
  });

  it('frees capacity on release', async () => {
    const max = 2;
    await acquire(tenantSlotMember('c1', 't1'), max);
    await acquire(tenantSlotMember('c2', 't2'), max);
    assert.equal((await acquire(tenantSlotMember('c3', 't3'), max)).acquired, false);

    await release(tenantSlotMember('c1', 't1'));
    assert.equal((await acquire(tenantSlotMember('c3', 't3'), max)).acquired, true);
  });

  it('never goes negative, however many spurious releases arrive', async () => {
    // The counter's fatal property: DECR on a missing key recreates it at -1 with no TTL, and the
    // cap check silently passes for every job after that.
    for (let i = 0; i < 5; i += 1) {
      await release(tenantSlotMember('ghost', `tok-${i}`));
    }
    assert.equal(await redis.zcard(KEY), 0);

    const result = await acquire(tenantSlotMember('c1', 't1'), 1);
    assert.equal(result.acquired, true);
    assert.equal(result.active, 1, 'phantom releases must not create negative headroom');
    assert.equal((await acquire(tenantSlotMember('c2', 't2'), 1)).acquired, false);
  });
});

describe('tenant slot lease — expiry self-heal', () => {
  it('reclaims an EXPIRED lease on the next acquire, with no explicit release', async () => {
    // A job SIGKILLed between acquire and its `finally` never releases. With the counter this leaked
    // a slot until the whole key expired; with leases the individual member is pruned on the next
    // acquire, so the tenant loses one slot for one TTL rather than being wedged.
    const past = Date.now() - 10_000;
    const crashed = await acquire(tenantSlotMember('crashed', 'tok-crashed'), 1, 1_000, past);
    assert.equal(crashed.acquired, true);
    assert.equal(await redis.zcard(KEY), 1);

    const next = await acquire(tenantSlotMember('fresh', 'tok-fresh'), 1, 5_000, Date.now());
    assert.equal(next.acquired, true, 'the expired lease must not block the tenant forever');
    assert.equal(next.active, 1);
    assert.equal(await redis.zcard(KEY), 1, 'the dead member is pruned, not accumulated');
  });

  it('does not prune a live lease', async () => {
    const now = Date.now();
    await acquire(tenantSlotMember('live', 'tok-live'), 2, 60_000, now);
    await acquire(tenantSlotMember('other', 'tok-other'), 2, 60_000, now + 1);
    assert.equal(await redis.zcard(KEY), 2);
  });

  it('keeps a key-level TTL so a quiet tenant does not leak a key forever', async () => {
    await acquire(tenantSlotMember('c1', 't1'), 4, 5_000);
    const ttl = await redis.pttl(KEY);
    assert.ok(ttl > 0, 'expected a key-level PEXPIRE backstop');
    assert.ok(ttl > 5_000, 'the backstop must exceed the lease TTL so it never truncates a live lease');
  });
});

describe('tenant slot lease — token scoping', () => {
  it('releases only the caller’s own lease', async () => {
    const max = 3;
    await acquire(tenantSlotMember('c1', 't1'), max);
    await acquire(tenantSlotMember('c2', 't2'), max);

    const remaining = await release(tenantSlotMember('c1', 't1'));
    assert.equal(remaining, 1);
    const members = await redis.zrange(KEY, 0, -1);
    assert.deepEqual(members, [tenantSlotMember('c2', 't2')]);
  });

  it('a late release from a job whose lease already expired cannot steal a live slot', async () => {
    // Impossible to guarantee with a shared counter, structural here: the member simply is not
    // present, so ZREM is a no-op.
    const past = Date.now() - 10_000;
    await acquire(tenantSlotMember('slow', 'tok-slow'), 1, 1_000, past);
    const fresh = await acquire(tenantSlotMember('fresh', 'tok-fresh'), 1, 60_000, Date.now());
    assert.equal(fresh.acquired, true);

    await release(tenantSlotMember('slow', 'tok-slow'));
    assert.equal(await redis.zcard(KEY), 1, "the slow job's late release must not free someone else's slot");
    assert.deepEqual(await redis.zrange(KEY, 0, -1), [tenantSlotMember('fresh', 'tok-fresh')]);
  });

  it('re-acquiring with the same member is idempotent, not double-counted', async () => {
    const first = await acquire(tenantSlotMember('c1', 't1'), 2);
    const second = await acquire(tenantSlotMember('c1', 't1'), 2);
    assert.equal(first.acquired, true);
    assert.equal(second.acquired, true);
    assert.equal(await redis.zcard(KEY), 1, 'ZADD on an existing member updates the score, not the count');
  });
});

describe('tenant slot lease — concurrency', () => {
  it('two racing acquires for the last slot cannot both win', async () => {
    // The whole point of doing this in Lua: prune, count and add are one atomic server-side step.
    const max = 1;
    const [a, b] = await Promise.all([
      acquire(tenantSlotMember('c1', 't1'), max),
      acquire(tenantSlotMember('c2', 't2'), max),
    ]);
    const winners = [a, b].filter((r) => r.acquired);
    assert.equal(winners.length, 1, 'exactly one of two racers may hold the single slot');
    assert.equal(await redis.zcard(KEY), 1);
  });

  it('admits exactly `max` out of many simultaneous contenders', async () => {
    const max = 4;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => acquire(tenantSlotMember(`c${i}`, `t${i}`), max)),
    );
    assert.equal(results.filter((r) => r.acquired).length, max);
    assert.equal(await redis.zcard(KEY), max);
  });
});
