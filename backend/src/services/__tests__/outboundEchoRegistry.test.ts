/**
 * Tests for the self-send echo registry tri-state (P0-7, RC-24).
 *
 * `lookupSelfSentMessageEcho` must distinguish a genuine registry MISS from a Redis READ
 * ERROR — the conflation of the two ("both false") is what let the AI's own Instagram echo
 * (no `app_id`) be misclassified as a human agent reply on any Redis hiccup. These tests
 * pin all three outcomes ('self' | 'miss' | 'error') plus the mark path, using injected
 * stub clients so the suite stays offline. The real-Redis round-trip lives in
 * `src/__integration__/outboundEchoRegistry.integration.test.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupSelfSentMessageEcho,
  markSelfSentMessageEcho,
  selfEchoKey,
  SELF_ECHO_TTL_SECONDS,
  type SelfEchoRedisClient,
} from '../outboundEchoRegistry';

/** A stub client recording calls; behaviour configured per test. */
function makeStubClient(behaviour: {
  get?: (key: string) => Promise<string | null>;
  set?: (key: string, value: string, expiryMode: 'EX', ttl: number) => Promise<unknown>;
}): SelfEchoRedisClient & { calls: Array<{ op: 'get' | 'set'; key: string; ttl?: number }> } {
  const calls: Array<{ op: 'get' | 'set'; key: string; ttl?: number }> = [];
  return {
    calls,
    async get(key: string) {
      calls.push({ op: 'get', key });
      return behaviour.get ? behaviour.get(key) : null;
    },
    async set(key: string, value: string, expiryMode: 'EX', ttl: number) {
      calls.push({ op: 'set', key, ttl });
      return behaviour.set ? behaviour.set(key, value, expiryMode, ttl) : 'OK';
    },
  };
}

describe('lookupSelfSentMessageEcho — tri-state', () => {
  it("returns 'self' on a registry hit (truthy GET)", async () => {
    const client = makeStubClient({ get: async () => '1' });
    assert.equal(await lookupSelfSentMessageEcho('mid_123', client), 'self');
    assert.deepEqual(client.calls, [{ op: 'get', key: selfEchoKey('mid_123') }]);
  });

  it("returns 'miss' on a genuine miss (nil GET)", async () => {
    const client = makeStubClient({ get: async () => null });
    assert.equal(await lookupSelfSentMessageEcho('mid_unknown', client), 'miss');
  });

  it("returns 'error' when the Redis read throws — distinguishable from a miss (the RC-24 fix)", async () => {
    const client = makeStubClient({
      get: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    assert.equal(await lookupSelfSentMessageEcho('mid_123', client), 'error');
  });

  it("returns 'miss' for an empty/null id without touching Redis", async () => {
    const client = makeStubClient({});
    assert.equal(await lookupSelfSentMessageEcho(null, client), 'miss');
    assert.equal(await lookupSelfSentMessageEcho(undefined, client), 'miss');
    assert.equal(await lookupSelfSentMessageEcho('   ', client), 'miss');
    assert.deepEqual(client.calls, []);
  });
});

describe('markSelfSentMessageEcho', () => {
  it('records the id under the self_send_echo: prefix with the registry TTL', async () => {
    const client = makeStubClient({});
    await markSelfSentMessageEcho('mid_abc', client);
    assert.deepEqual(client.calls, [
      { op: 'set', key: selfEchoKey('mid_abc'), ttl: SELF_ECHO_TTL_SECONDS },
    ]);
  });

  it('is best-effort: a Redis write error never throws to the send path', async () => {
    const client = makeStubClient({
      set: async () => {
        throw new Error('READONLY You cannot write against a replica');
      },
    });
    await assert.doesNotReject(markSelfSentMessageEcho('mid_abc', client));
  });

  it('ignores empty/null ids without touching Redis', async () => {
    const client = makeStubClient({});
    await markSelfSentMessageEcho(null, client);
    await markSelfSentMessageEcho('  ', client);
    assert.deepEqual(client.calls, []);
  });
});
