/**
 * Integration tests for the P0-7 (RC-24) self-send echo registry against a REAL Redis —
 * including the real error path via a client pointed at a dead port (not a stub).
 *
 * The offline suite (services/__tests__/outboundEchoRegistry.test.ts) pins the tri-state
 * with stub clients; this file proves the same contract over the wire: mark → 'self',
 * unknown → 'miss', unreachable Redis → 'error' (never a false 'miss'), and a mark
 * failure never throws into the send path.
 *
 * Run with `npm run test:integration` (requires Redis; REDIS_URL to override).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type IORedis from 'ioredis';
import {
  lookupSelfSentMessageEcho,
  markSelfSentMessageEcho,
  selfEchoKey,
  SELF_ECHO_TTL_SECONDS,
} from '../services/outboundEchoRegistry';
import { createBrokenRedisClient, createRedisTestClient } from './redisTestClient';

describe('outboundEchoRegistry (real Redis)', () => {
  let redis: IORedis;
  const mid = `test_mid_${crypto.randomUUID()}`;

  before(async () => {
    redis = createRedisTestClient();
    await redis.connect();
    await redis.del(selfEchoKey(mid));
  });

  after(async () => {
    await redis.del(selfEchoKey(mid));
    await redis.quit();
  });

  it("mark → lookup round-trip returns 'self' with the registry TTL armed", async () => {
    await markSelfSentMessageEcho(mid, redis);
    assert.equal(await lookupSelfSentMessageEcho(mid, redis), 'self');

    const ttl = await redis.ttl(selfEchoKey(mid));
    assert.ok(
      ttl > 0 && ttl <= SELF_ECHO_TTL_SECONDS,
      `registry entry expires on its own (got ${ttl})`,
    );
  });

  it("an id we never marked returns 'miss'", async () => {
    assert.equal(await lookupSelfSentMessageEcho(`never_${crypto.randomUUID()}`, redis), 'miss');
  });
});

describe('outboundEchoRegistry (unreachable Redis — the RC-24 failure mode, for real)', () => {
  let broken: IORedis;

  before(() => {
    broken = createBrokenRedisClient();
  });

  after(() => {
    broken.disconnect();
  });

  it("a real connection failure reads as 'error', never a false 'miss'", async () => {
    assert.equal(await lookupSelfSentMessageEcho('mid_whatever', broken), 'error');
  });

  it('a mark against a dead Redis resolves without throwing into the send path', async () => {
    await assert.doesNotReject(markSelfSentMessageEcho('mid_whatever', broken));
  });
});
