/**
 * Integration tests for the P0-6 (RC-18) count-once Lua script against a REAL Redis.
 *
 * This is the contract that makes delivered-only rate counting billing-safe:
 *   - one budget unit per delivered inbound, idempotent across BullMQ retries (marker
 *     SET NX), atomic with the counter INCR;
 *   - the rolling-1h EXPIRE is set on the FIRST real increment only — later increments
 *     must never reset the window, and no counter can exist without a TTL (the legacy
 *     INCR+EXPIRE race that permanently locked conversations).
 *
 * The offline suite covers the pure predicates; only a real Redis can verify the script
 * semantics. Run with `npm run test:integration` (requires Redis; REDIS_URL to override).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type IORedis from 'ioredis';
import { RATE_LIMIT_DELIVERED_INCR_SCRIPT } from '../services/rateLimitDeliveredCount';
import { createRedisTestClient } from './redisTestClient';

const TTL_SECONDS = '3600';

describe('RATE_LIMIT_DELIVERED_INCR_SCRIPT (real Redis)', () => {
  let redis: IORedis;
  const run = crypto.randomUUID();
  const counterKey = `test:ai_rate_limit:${run}`;
  const marker = (inbound: string) => `test:ai_rate_counted:${run}:${inbound}`;
  const keysUsed = [counterKey, marker('m1'), marker('m2'), marker('m3')];

  const evalOnce = async (markerKey: string): Promise<number> =>
    (await redis.eval(
      RATE_LIMIT_DELIVERED_INCR_SCRIPT,
      2,
      counterKey,
      markerKey,
      TTL_SECONDS,
    )) as number;

  before(async () => {
    redis = createRedisTestClient();
    await redis.connect();
    await redis.del(...keysUsed);
  });

  after(async () => {
    await redis.del(...keysUsed);
    await redis.quit();
  });

  it('first delivered reply increments to 1 and arms both TTLs atomically', async () => {
    assert.equal(await evalOnce(marker('m1')), 1);
    assert.equal(await redis.get(counterKey), '1');

    const counterTtl = await redis.ttl(counterKey);
    assert.ok(counterTtl > 0 && counterTtl <= 3600, `counter TTL armed (got ${counterTtl})`);
    const markerTtl = await redis.ttl(marker('m1'));
    assert.ok(markerTtl > 0 && markerTtl <= 3600, `marker TTL armed (got ${markerTtl})`);
  });

  it('a retry of the SAME inbound no-ops: counter unchanged, current value returned', async () => {
    assert.equal(await evalOnce(marker('m1')), 1);
    assert.equal(await evalOnce(marker('m1')), 1);
    assert.equal(await redis.get(counterKey), '1');
  });

  it('a different inbound increments normally', async () => {
    assert.equal(await evalOnce(marker('m2')), 2);
    assert.equal(await redis.get(counterKey), '2');
  });

  it('later increments do NOT reset the rolling window (EXPIRE only on first)', async () => {
    // Shrink the counter's TTL, then deliver another inbound: if the script re-armed
    // EXPIRE on every increment, the TTL would jump back toward 3600.
    await redis.expire(counterKey, 50);
    assert.equal(await evalOnce(marker('m3')), 3);
    const ttl = await redis.ttl(counterKey);
    assert.ok(ttl > 0 && ttl <= 50, `window preserved (got ${ttl})`);
  });

  it('a same-inbound retry also leaves the window untouched', async () => {
    assert.equal(await evalOnce(marker('m3')), 3);
    const ttl = await redis.ttl(counterKey);
    assert.ok(ttl > 0 && ttl <= 50, `window preserved on no-op (got ${ttl})`);
  });
});
