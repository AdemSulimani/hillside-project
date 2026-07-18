/**
 * Integration tests for the P2-3 (RC-17 + C-55) SET-IF-STRICTLY-NEWER cache script against a REAL
 * Redis — the committed form of the validations the P2-3 audit found only as a documented live
 * dev-Redis session (finding B-F1):
 *
 *   - the REFILL-RESURRECTION race: a slow reader's stale populate arriving AFTER a newer
 *     write-through (the C-55 toggle shape) must be rejected, not served for 900s;
 *   - equal-version semantics: the comparator is STRICTLY newer — an equal version is rejected,
 *     so two writers with the same row version cannot flap the stored bytes;
 *   - the undecodable/legacy-shape escape hatch: garbage in the key must not brick the cache.
 *
 * The offline suite (aiConfigVersionedCache.test.ts) covers the pure helpers; only a real Redis
 * can verify the script's atomicity semantics. Run with `npm run test:integration`.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type IORedis from 'ioredis';
import { SET_IF_NEWER_LUA } from '../services/aiConfigCache';
import { createRedisTestClient } from './redisTestClient';

const TTL_SECONDS = '900';

describe('SET_IF_NEWER_LUA (real Redis)', () => {
  let redis: IORedis;
  const run = crypto.randomUUID();
  const key = `test:ai_config:v:${run}`;

  const payload = (v: number, data: unknown) => JSON.stringify({ v, data });
  const setIfNewer = async (v: number, data: unknown): Promise<number> =>
    (await redis.eval(SET_IF_NEWER_LUA, 1, key, String(v), payload(v, data), TTL_SECONDS)) as number;
  const stored = async (): Promise<{ v: number; data: unknown } | null> => {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as { v: number; data: unknown }) : null;
  };

  before(async () => {
    redis = createRedisTestClient();
    await redis.connect();
    await redis.del(key);
  });

  after(async () => {
    await redis.del(key);
    await redis.quit();
  });

  it('populates an empty key and arms the TTL', async () => {
    assert.equal(await setIfNewer(100, { tone: 'v100' }), 1);
    assert.deepEqual(await stored(), { v: 100, data: { tone: 'v100' } });
    const ttl = await redis.ttl(key);
    assert.ok(ttl > 0 && ttl <= 900, `TTL armed (got ${ttl})`);
  });

  it('a strictly newer version replaces the stored value', async () => {
    assert.equal(await setIfNewer(200, { tone: 'v200' }), 1);
    assert.deepEqual(await stored(), { v: 200, data: { tone: 'v200' } });
  });

  it('an EQUAL version is rejected (strictly-newer comparator)', async () => {
    assert.equal(await setIfNewer(200, { tone: 'v200-flap' }), 0);
    assert.deepEqual(await stored(), { v: 200, data: { tone: 'v200' } });
  });

  it('an older version is rejected and cannot clobber the stored value', async () => {
    assert.equal(await setIfNewer(150, { tone: 'v150-stale' }), 0);
    assert.deepEqual(await stored(), { v: 200, data: { tone: 'v200' } });
  });

  it('THE RESURRECTION RACE (C-55 shape): a stale populate landing after DEL + newer write-through is rejected', async () => {
    // t0: a slow reader has loaded the pre-toggle row (v=300 will be its populate).
    // t1: the toggle path invalidates (DEL) and write-throughs the fresh row (v=301).
    // t2: the slow reader's populate finally arrives with the OLD version — the exact interleaving
    //     that resurrected a stale config for up to 900s under the legacy unconditional SET.
    await redis.del(key);
    assert.equal(await setIfNewer(301, { is_active: false, note: 'post-toggle' }), 1);
    assert.equal(await setIfNewer(300, { is_active: true, note: 'pre-toggle-stale' }), 0);
    assert.deepEqual(await stored(), { v: 301, data: { is_active: false, note: 'post-toggle' } });
  });

  it('an undecodable / legacy-shape stored value is overwritten, not bricked', async () => {
    await redis.set(key, 'legacy-not-json{', 'EX', 900);
    assert.equal(await setIfNewer(50, { tone: 'recovered' }), 1);
    assert.deepEqual(await stored(), { v: 50, data: { tone: 'recovered' } });
  });

  it('a legacy JSON value WITHOUT a numeric v field is also overwritten', async () => {
    await redis.set(key, JSON.stringify({ tone: 'legacy-shape' }), 'EX', 900);
    assert.equal(await setIfNewer(60, { tone: 'recovered-2' }), 1);
    assert.deepEqual(await stored(), { v: 60, data: { tone: 'recovered-2' } });
  });
});
