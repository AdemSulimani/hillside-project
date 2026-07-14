/**
 * P1-3 (RC-08): per-message classifier-verdict persistence — a BullMQ retry must consume the
 * first attempt's verdict instead of re-rolling the stochastic detector. Covers: flag-off
 * pass-through, cache hit (no recompute), corrupted-entry recovery, and Redis fail-open.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifierVerdictKey,
  getOrComputeClassifierVerdict,
  type VerdictRedisLike,
} from '../classifierVerdictStore';

function fakeRedis(initial: Record<string, string> = {}): VerdictRedisLike & {
  store: Map<string, string>;
  getCalls: number;
  setCalls: number;
} {
  const store = new Map(Object.entries(initial));
  const r = {
    store,
    getCalls: 0,
    setCalls: 0,
    async get(key: string) {
      r.getCalls += 1;
      return store.get(key) ?? null;
    },
    async set(key: string, value: string) {
      r.setCalls += 1;
      store.set(key, value);
      return 'OK';
    },
  };
  return r;
}

const ARGS = {
  conversationId: '11111111-1111-1111-1111-111111111111',
  inboundExternalId: 'mid.100',
  detector: 'cancellation_refund',
};

describe('classifierVerdictKey', () => {
  it('is stable and distinct per detector and per inbound', () => {
    assert.equal(
      classifierVerdictKey(ARGS.conversationId, ARGS.inboundExternalId, ARGS.detector),
      `ai_clf:${ARGS.conversationId}:${ARGS.inboundExternalId}:${ARGS.detector}`,
    );
    assert.notEqual(
      classifierVerdictKey(ARGS.conversationId, 'mid.100', 'a'),
      classifierVerdictKey(ARGS.conversationId, 'mid.100', 'b'),
    );
    assert.notEqual(
      classifierVerdictKey(ARGS.conversationId, 'mid.100', 'a'),
      classifierVerdictKey(ARGS.conversationId, 'mid.101', 'a'),
    );
  });
});

describe('getOrComputeClassifierVerdict', () => {
  it('flag off → computes every time and never touches Redis', async () => {
    const redis = fakeRedis();
    let calls = 0;
    const compute = async () => ({ confidence: 0.9, calls: (calls += 1) });
    const a = await getOrComputeClassifierVerdict({ ...ARGS, compute, enabled: false, redis });
    const b = await getOrComputeClassifierVerdict({ ...ARGS, compute, enabled: false, redis });
    assert.equal(a.calls, 1);
    assert.equal(b.calls, 2);
    assert.equal(redis.getCalls, 0);
    assert.equal(redis.setCalls, 0);
  });

  it('enabled → first call computes + persists; second call is served without recompute', async () => {
    const redis = fakeRedis();
    let computeCount = 0;
    const compute = async () => {
      computeCount += 1;
      return { is_refund: true, confidence: 0.86 };
    };
    const first = await getOrComputeClassifierVerdict({ ...ARGS, compute, enabled: true, redis });
    const second = await getOrComputeClassifierVerdict({ ...ARGS, compute, enabled: true, redis });
    assert.equal(computeCount, 1, 'the retry must NOT re-roll the classifier');
    assert.deepEqual(second, first);
  });

  it('a corrupted cached entry falls through to a fresh compute', async () => {
    const key = classifierVerdictKey(ARGS.conversationId, ARGS.inboundExternalId, ARGS.detector);
    const redis = fakeRedis({ [key]: '{not json' });
    let computeCount = 0;
    const compute = async () => {
      computeCount += 1;
      return { confidence: 0.5 };
    };
    const out = await getOrComputeClassifierVerdict({ ...ARGS, compute, enabled: true, redis });
    assert.equal(computeCount, 1);
    assert.equal(out.confidence, 0.5);
  });

  it('Redis get/set failures fail OPEN: the verdict still computes and returns', async () => {
    const redis: VerdictRedisLike = {
      async get() {
        throw new Error('redis down');
      },
      async set() {
        throw new Error('redis down');
      },
    };
    const out = await getOrComputeClassifierVerdict({
      ...ARGS,
      compute: async () => ({ confidence: 0.7 }),
      enabled: true,
      redis,
    });
    assert.equal(out.confidence, 0.7);
  });
});
