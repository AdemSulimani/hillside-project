/**
 * Tests for P1-4 (RC-04) retrieval reliability: aborting embedding timeout + negative/shared
 * query-embedding cache + dimension guard + similarity-threshold hysteresis.
 *
 * All pure/in-process (no network/DB/OpenAI): the orchestrator takes an injectable `deps` bag
 * (mirrors `outboundEchoRegistry.ts`'s injected client and `productRetrieval.test.ts`'s injected
 * matcher), so the abort, negative-cache (incl. the TTL=0 kill switch), single-flight, fail-open,
 * dimension-guard and hysteresis branches are all exercised in one process with hand-rolled stub
 * clients — no mocking framework.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTED_EMBEDDING_DIM,
  activeEmbeddingModel,
  createInProcessEmbeddingCache,
  decodeVector,
  encodeVector,
  getOrComputeQueryEmbedding,
  isExpectedDimension,
  negativeCacheKey,
  partitionBySimilarityBand,
  queryEmbeddingRedisKey,
  resolveQueryEmbedding,
  type EmbedFn,
  type RetrievalRedisClient,
} from '../retrievalReliability';

// ---------------------------------------------------------------------------
// Test doubles.
// ---------------------------------------------------------------------------

/** A Map-backed fake Redis that can be told to throw on any op (to simulate a Redis outage). */
function makeFakeRedis(opts: { failGet?: boolean; failSet?: boolean; failIncr?: boolean } = {}) {
  const store = new Map<string, string>();
  const calls = { get: 0, set: 0, incr: 0 };
  const client: RetrievalRedisClient & { store: Map<string, string>; calls: typeof calls } = {
    store,
    calls,
    async get(key) {
      calls.get++;
      if (opts.failGet) throw new Error('redis down');
      return store.get(key) ?? null;
    },
    async set(key, value, _mode, _ttl) {
      calls.set++;
      if (opts.failSet) throw new Error('redis down');
      store.set(key, value);
      return 'OK';
    },
    async incr(key) {
      calls.incr++;
      if (opts.failIncr) throw new Error('redis down');
      const next = Number(store.get(key) ?? '0') + 1;
      store.set(key, String(next));
      return next;
    },
  };
  return client;
}

/** A deterministic vector of the requested dimension. */
function vec(dim: number, base = 0.1): number[] {
  return Array.from({ length: dim }, (_, i) => base + i * 1e-5);
}

/** An `embed` that hangs until aborted (simulates OpenAI slower than the deadline). */
function hangingEmbed(counter?: { calls: number }): EmbedFn {
  return (_text, { signal }) =>
    new Promise<number[]>((_resolve, reject) => {
      if (counter) counter.calls++;
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
}

const MODEL = 'test-embed-model';
const base = () => ({
  redis: makeFakeRedis(),
  model: MODEL,
  timeoutMs: 5000,
  sharedCache: false,
  inProcess: createInProcessEmbeddingCache(),
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

describe('isExpectedDimension', () => {
  it('accepts the column dimension and rejects a -large 3072 vector', () => {
    assert.equal(EXPECTED_EMBEDDING_DIM, 1536);
    assert.equal(isExpectedDimension(vec(1536)), true);
    assert.equal(isExpectedDimension(vec(3072)), false);
    assert.equal(isExpectedDimension([]), false);
  });
});

describe('encodeVector / decodeVector (base64 Float32)', () => {
  it('round-trips within Float32 precision and preserves length', () => {
    const original = [0.1, -0.5, 0.333333, 0.99999, 0];
    const decoded = decodeVector(encodeVector(original));
    assert.equal(decoded.length, original.length);
    for (let i = 0; i < original.length; i++) {
      assert.ok(Math.abs(decoded[i] - original[i]) < 1e-6, `index ${i}`);
    }
  });

  it('round-trips a full 1536-dim vector', () => {
    const decoded = decodeVector(encodeVector(vec(1536)));
    assert.equal(decoded.length, 1536);
  });
});

describe('partitionBySimilarityBand', () => {
  const items = [{ similarity: 0.7 }, { similarity: 0.65 }, { similarity: 0.63 }, { similarity: 0.6 }];

  it('band=0 reproduces the legacy `>= threshold` filter (band always empty)', () => {
    const { core, band } = partitionBySimilarityBand(items, 0.65, 0);
    assert.deepEqual(core.map((c) => c.similarity), [0.7, 0.65]);
    assert.equal(band.length, 0);
  });

  it('band>0 admits [threshold-band, threshold) into the band and excludes below', () => {
    const { core, band } = partitionBySimilarityBand(items, 0.65, 0.03);
    assert.deepEqual(core.map((c) => c.similarity), [0.7, 0.65]);
    assert.deepEqual(band.map((b) => b.similarity), [0.63]); // 0.63 in [0.62, 0.65); 0.60 out
  });
});

describe('cache keys', () => {
  it('are model-scoped, content-addressed and hashed (no raw text)', () => {
    const k = queryEmbeddingRedisKey(MODEL, 'sa kushton');
    assert.ok(k.startsWith(`qemb:${MODEL}:`));
    assert.ok(!k.includes('sa kushton')); // hashed — raw customer text never in the key
    assert.equal(k, queryEmbeddingRedisKey(MODEL, 'sa kushton')); // deterministic
    assert.notEqual(k, queryEmbeddingRedisKey(MODEL, 'other text'));
    assert.notEqual(k, queryEmbeddingRedisKey('other-model', 'sa kushton')); // model-scoped
    assert.ok(negativeCacheKey(MODEL, 'x').startsWith('qemb:neg:'));
  });
});

describe('activeEmbeddingModel', () => {
  it('prefers the env var, falls back otherwise', () => {
    const prev = process.env.OPENAI_EMBEDDING_MODEL;
    process.env.OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
    assert.equal(activeEmbeddingModel(), 'text-embedding-3-small');
    delete process.env.OPENAI_EMBEDDING_MODEL;
    assert.ok(activeEmbeddingModel().length > 0); // documented literal fallback
    if (prev !== undefined) process.env.OPENAI_EMBEDDING_MODEL = prev;
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — aborting timeout.
// ---------------------------------------------------------------------------

describe('resolveQueryEmbedding — aborting timeout', () => {
  it('actually aborts the request at the deadline, returns null, and negative-caches the skip', async () => {
    let capturedSignal: AbortSignal | undefined;
    const embed: EmbedFn = (_t, { signal }) =>
      new Promise<number[]>((_resolve, reject) => {
        capturedSignal = signal;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const redis = makeFakeRedis();

    const res = await resolveQueryEmbedding('q', {
      embed,
      redis,
      model: MODEL,
      timeoutMs: 10, // fires quickly
      inProcess: createInProcessEmbeddingCache(),
      sharedCache: false,
    });

    assert.equal(res.vector, null);
    assert.equal(res.reason, 'embedding_timeout');
    assert.equal(capturedSignal?.aborted, true, 'the underlying request must be aborted, not abandoned');
    assert.ok(redis.store.has(negativeCacheKey(MODEL, 'q')), 'the timeout must be negative-cached');
  });

  it('classifies an immediate (non-abort) failure as embedding_error', async () => {
    const embed: EmbedFn = async () => {
      throw new Error('500 from OpenAI');
    };
    const res = await resolveQueryEmbedding('q', { ...base(), embed });
    assert.equal(res.vector, null);
    assert.equal(res.reason, 'embedding_error');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — negative cache prevents the re-race.
// ---------------------------------------------------------------------------

describe('resolveQueryEmbedding — negative cache', () => {
  it('a timed-out query does not re-race: the second identical call skips without calling embed', async () => {
    const redis = makeFakeRedis();
    const inProcess = createInProcessEmbeddingCache();
    const counter = { calls: 0 };
    const embed = hangingEmbed(counter);

    const first = await resolveQueryEmbedding('q', {
      embed,
      redis,
      model: MODEL,
      timeoutMs: 10,
      inProcess,
      sharedCache: false,
    });
    assert.equal(first.reason, 'embedding_timeout');
    assert.equal(counter.calls, 1);

    const second = await resolveQueryEmbedding('q', {
      embed,
      redis,
      model: MODEL,
      timeoutMs: 10,
      inProcess,
      sharedCache: false,
    });
    assert.equal(second.source, 'negative_cache');
    assert.equal(second.vector, null);
    assert.equal(counter.calls, 1, 'embed must NOT be invoked again — the skip is cached');
  });

  it('negCacheTtl=0 is the kill switch: no sentinel is written and a second call re-invokes embed', async () => {
    const redis = makeFakeRedis();
    const inProcess = createInProcessEmbeddingCache();
    const counter = { calls: 0 };
    const embed = hangingEmbed(counter);
    const deps = { embed, redis, model: MODEL, timeoutMs: 10, inProcess, sharedCache: false, negCacheTtl: 0 };

    const first = await resolveQueryEmbedding('q', deps);
    assert.equal(first.reason, 'embedding_timeout');
    assert.ok(!redis.store.has(negativeCacheKey(MODEL, 'q')), 'kill switch must suppress the sentinel write');

    const second = await resolveQueryEmbedding('q', deps);
    assert.equal(second.reason, 'embedding_timeout');
    assert.equal(counter.calls, 2, 'with negative caching disabled, embed IS re-invoked');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — fail-open when Redis is down.
// ---------------------------------------------------------------------------

describe('resolveQueryEmbedding — fail-open', () => {
  it('computes normally when the Redis READ throws (never forces a skip)', async () => {
    const redis = makeFakeRedis({ failGet: true });
    const embed: EmbedFn = async () => vec(1536);
    const res = await resolveQueryEmbedding('q', {
      embed,
      redis,
      model: MODEL,
      timeoutMs: 5000,
      inProcess: createInProcessEmbeddingCache(),
      sharedCache: true, // exercise the shared-read path
    });
    assert.equal(res.source, 'computed');
    assert.equal(res.vector?.length, 1536);
  });

  it('computes normally when the Redis WRITE throws', async () => {
    const redis = makeFakeRedis({ failSet: true });
    const embed: EmbedFn = async () => vec(1536);
    const res = await resolveQueryEmbedding('q', {
      embed,
      redis,
      model: MODEL,
      timeoutMs: 5000,
      inProcess: createInProcessEmbeddingCache(),
      sharedCache: true,
    });
    assert.equal(res.source, 'computed');
    assert.equal(res.vector?.length, 1536);
  });

  it('returns normally even when the metric counter (incr) throws', async () => {
    const redis = makeFakeRedis({ failIncr: true });
    const embed: EmbedFn = async () => {
      throw new Error('boom');
    };
    const res = await resolveQueryEmbedding('q', { ...base(), embed, redis });
    assert.equal(res.reason, 'embedding_error'); // reached the skip path AND returned cleanly
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — dimension guard (the -large 3072 landmine).
// ---------------------------------------------------------------------------

describe('resolveQueryEmbedding — dimension guard', () => {
  it('rejects a wrong-dimension vector and negative-caches it ONCE (not recomputed every call)', async () => {
    const redis = makeFakeRedis();
    const inProcess = createInProcessEmbeddingCache();
    const counter = { calls: 0 };
    const embed: EmbedFn = async () => {
      counter.calls++;
      return vec(3072); // e.g. text-embedding-3-large against a vector(1536) column
    };

    const first = await resolveQueryEmbedding('q', {
      embed,
      redis,
      model: MODEL,
      timeoutMs: 5000,
      inProcess,
      sharedCache: false,
    });
    assert.equal(first.vector, null);
    assert.equal(first.reason, 'dim_mismatch');
    assert.equal(counter.calls, 1);
    assert.ok(redis.store.has(negativeCacheKey(MODEL, 'q')));

    const second = await resolveQueryEmbedding('q', {
      embed,
      redis,
      model: MODEL,
      timeoutMs: 5000,
      inProcess,
      sharedCache: false,
    });
    assert.equal(second.source, 'negative_cache');
    assert.equal(counter.calls, 1, 'a permanently-bad vector must not be recomputed every request');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — positive caching + cross-worker convergence.
// ---------------------------------------------------------------------------

describe('resolveQueryEmbedding — positive cache', () => {
  it('serves the in-process cache on the second call (model-scoped) and misses on a model change', async () => {
    const redis = makeFakeRedis();
    const inProcess = createInProcessEmbeddingCache();
    const counter = { calls: 0 };
    const embed: EmbedFn = async () => {
      counter.calls++;
      return vec(1536);
    };
    const deps = { redis, timeoutMs: 5000, inProcess, sharedCache: false };

    const first = await resolveQueryEmbedding('q', { ...deps, embed, model: MODEL });
    assert.equal(first.source, 'computed');
    assert.equal(counter.calls, 1);

    const second = await resolveQueryEmbedding('q', { ...deps, embed, model: MODEL });
    assert.equal(second.source, 'inprocess');
    assert.equal(counter.calls, 1);

    // Same text, DIFFERENT model → different key → miss (no cross-model vector mixing).
    const third = await resolveQueryEmbedding('q', { ...deps, embed, model: 'other-model' });
    assert.equal(third.source, 'computed');
    assert.equal(counter.calls, 2);
  });

  it('shares positives across two workers via Redis when RETRIEVAL_SHARED_CACHE is on', async () => {
    const sharedRedis = makeFakeRedis();
    const workerA = createInProcessEmbeddingCache();
    const workerB = createInProcessEmbeddingCache();
    const embedA: EmbedFn = async () => vec(1536);
    const bCounter = { calls: 0 };
    const embedB: EmbedFn = async () => {
      bCounter.calls++;
      return vec(1536);
    };
    const common = { redis: sharedRedis, model: MODEL, timeoutMs: 5000, sharedCache: true };

    const a = await resolveQueryEmbedding('q', { ...common, embed: embedA, inProcess: workerA });
    assert.equal(a.source, 'computed');
    assert.ok(sharedRedis.store.has(queryEmbeddingRedisKey(MODEL, 'q')));

    // Worker B has a cold in-process cache but reads the shared vector — it does NOT recompute.
    const b = await resolveQueryEmbedding('q', { ...common, embed: embedB, inProcess: workerB });
    assert.equal(b.source, 'shared');
    assert.equal(b.vector?.length, 1536);
    assert.equal(bCounter.calls, 0, 'worker B must converge on the shared vector, not re-embed');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — single-flight (concurrent identical cold queries share one compute).
// ---------------------------------------------------------------------------

describe('resolveQueryEmbedding — single-flight', () => {
  it('two concurrent identical cold queries invoke embed exactly once and share the vector', async () => {
    const counter = { calls: 0 };
    const embed: EmbedFn = async () => {
      counter.calls++;
      await new Promise((resolve) => setImmediate(resolve)); // stay in flight across both calls
      return vec(1536);
    };
    const deps = { ...base(), embed };

    // Launched back-to-back in the same tick — the second must join the first's flight.
    const [a, b] = await Promise.all([
      resolveQueryEmbedding('q', deps),
      resolveQueryEmbedding('q', deps),
    ]);
    assert.equal(counter.calls, 1, 'concurrent identical queries must share ONE OpenAI call');
    assert.equal(a.source, 'computed');
    assert.equal(a.vector?.length, 1536);
    assert.equal(a.vector, b.vector, 'both callers must resolve to the same vector');
  });

  it('removes the in-flight entry after a failure, so a later call re-computes', async () => {
    const counter = { calls: 0 };
    const embed: EmbedFn = async () => {
      counter.calls++;
      throw new Error('boom');
    };
    // redis: null → no negative caching, so a repeat compute proves the MAP entry was removed.
    const deps = { ...base(), embed, redis: null };

    const [a, b] = await Promise.all([
      resolveQueryEmbedding('q', deps),
      resolveQueryEmbedding('q', deps),
    ]);
    assert.equal(counter.calls, 1, 'the failing computation is still shared while in flight');
    assert.equal(a.reason, 'embedding_error');
    assert.equal(b.reason, 'embedding_error');

    const third = await resolveQueryEmbedding('q', deps);
    assert.equal(third.reason, 'embedding_error');
    assert.equal(counter.calls, 2, 'a failed flight must not poison later calls — entry removed in finally');
  });
});

// ---------------------------------------------------------------------------
// Thin wrapper.
// ---------------------------------------------------------------------------

describe('getOrComputeQueryEmbedding', () => {
  it('returns the vector on success and null on skip', async () => {
    const ok = await getOrComputeQueryEmbedding('q', { ...base(), embed: async () => vec(1536) });
    assert.equal(ok?.length, 1536);

    const skipped = await getOrComputeQueryEmbedding('q', {
      ...base(),
      embed: async () => {
        throw new Error('down');
      },
    });
    assert.equal(skipped, null);
  });
});
