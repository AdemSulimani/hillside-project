/**
 * P3-2 Step 3 (RC-04) — the pgvector iterative-scan capability probe.
 *
 * The asymmetry this pins: guessing "supported" when it is not is an OUTAGE, not a slowdown.
 * `SET LOCAL hnsw.iterative_scan = …` runs inside the similarity query's own transaction, so on a
 * pgvector < 0.8 server the unknown GUC aborts the query and retrieval returns nothing. Every
 * uncertain path must therefore resolve to `null` (emit no SET), never to an optimistic attempt.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretProbe,
  initVectorCapability,
  isIterativeScanSupported,
  iterativeScanSetting,
  resetVectorCapabilityForTests,
  ITERATIVE_SCAN_MODE,
} from '../vectorCapability';

const originalFlag = process.env.VECTOR_ITERATIVE_SCAN;

beforeEach(() => {
  resetVectorCapabilityForTests();
  delete process.env.VECTOR_ITERATIVE_SCAN;
});

afterEach(() => {
  resetVectorCapabilityForTests();
  if (originalFlag === undefined) delete process.env.VECTOR_ITERATIVE_SCAN;
  else process.env.VECTOR_ITERATIVE_SCAN = originalFlag;
});

describe('interpretProbe', () => {
  it('treats a real setting value as supported', () => {
    // pgvector >= 0.8 answers with the current mode, whatever it happens to be.
    assert.equal(interpretProbe({ iterativeScan: 'off' }), true);
    assert.equal(interpretProbe({ iterativeScan: 'strict_order' }), true);
    assert.equal(interpretProbe({ iterativeScan: 'relaxed_order' }), true);
  });

  it('treats a null setting as unsupported', () => {
    // `current_setting('hnsw.iterative_scan', true)` returns NULL when the GUC does not exist —
    // i.e. pgvector < 0.8, or the extension is not installed at all.
    assert.equal(interpretProbe({ iterativeScan: null }), false);
  });

  it('treats an empty string as unsupported', () => {
    assert.equal(interpretProbe({ iterativeScan: '' }), false);
  });

  it('treats a missing result as unsupported', () => {
    assert.equal(interpretProbe(null), false);
  });
});

describe('initVectorCapability', () => {
  it('caches the probe result and does not re-probe', async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return { iterativeScan: 'off' };
    };

    assert.equal(await initVectorCapability(probe), true);
    assert.equal(await initVectorCapability(probe), true);
    assert.equal(calls, 1, 'the probe opens a connection — it must run once per process');
  });

  it('resolves to unsupported when the probe throws, and never rethrows', async () => {
    // An unreachable database at boot must degrade to the existing adaptive-retry behaviour, not
    // crash the process.
    const supported = await initVectorCapability(async () => {
      throw new Error('connection refused');
    });
    assert.equal(supported, false);
    assert.equal(isIterativeScanSupported(), false);
  });

  it('reports unsupported before any probe has run', () => {
    assert.equal(isIterativeScanSupported(), false);
  });
});

describe('iterativeScanSetting — both conditions required', () => {
  it('returns null when supported but the flag is off', async () => {
    await initVectorCapability(async () => ({ iterativeScan: 'off' }));
    process.env.VECTOR_ITERATIVE_SCAN = 'false';
    assert.equal(iterativeScanSetting(), null);
  });

  it('returns null when the flag is on but support was never probed', () => {
    process.env.VECTOR_ITERATIVE_SCAN = 'true';
    assert.equal(
      iterativeScanSetting(),
      null,
      'an unprobed database must not get an optimistic SET — that aborts the similarity query',
    );
  });

  it('returns null when the flag is on but the database is too old', async () => {
    await initVectorCapability(async () => ({ iterativeScan: null }));
    process.env.VECTOR_ITERATIVE_SCAN = 'true';
    assert.equal(iterativeScanSetting(), null);
  });

  it('returns strict_order only when flag AND capability agree', async () => {
    await initVectorCapability(async () => ({ iterativeScan: 'off' }));
    process.env.VECTOR_ITERATIVE_SCAN = 'true';
    assert.equal(iterativeScanSetting(), 'strict_order');
  });

  it('never selects relaxed_order', () => {
    // partitionBySimilarityBand thresholds the rows and retrievalTop slices the first 8 as "the
    // closest matches" — both assume strictly descending similarity, which relaxed_order does not
    // guarantee.
    assert.equal(ITERATIVE_SCAN_MODE, 'strict_order');
  });
});
