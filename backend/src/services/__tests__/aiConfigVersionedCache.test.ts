/**
 * P2-3 (RC-17) tests for the versioned ai_config cache — the PURE version/normalize helpers that
 * decide the SET-IF-NEWER ordering. No Redis command is issued here (the client is lazyConnect, so
 * importing does not open a socket); the live Lua `SET_IF_NEWER` round-trip (a stale populate after a
 * newer write-through is rejected) is an offline-untestable seam validated against dev Redis in the
 * integration step. These tests lock the version math that governs accept/reject.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  aiConfigVersion,
  normalizeAiConfig,
  promptBlocksVersion,
} from '../aiConfigCache';

describe('aiConfigVersion', () => {
  it('is epoch-micros of updated_at', () => {
    const d = new Date('2026-07-14T10:00:00.000Z');
    assert.equal(aiConfigVersion(d), d.getTime() * 1000);
  });

  it('accepts a string timestamp identically', () => {
    const iso = '2026-07-14T10:00:00.000Z';
    assert.equal(aiConfigVersion(iso), new Date(iso).getTime() * 1000);
  });

  it('is 0 for null/undefined (the DEFAULT_AI_CONFIG floor)', () => {
    assert.equal(aiConfigVersion(null), 0);
    assert.equal(aiConfigVersion(undefined), 0);
  });

  it('orders two edits 1ms apart strictly (micros resolves sub-ms; a newer edit wins SET-IF-NEWER)', () => {
    const t1 = aiConfigVersion(new Date('2026-07-14T10:00:00.000Z'));
    const t2 = aiConfigVersion(new Date('2026-07-14T10:00:00.001Z'));
    assert.ok(t2 > t1, 'newer edit must have a strictly greater version');
    // equal timestamps → equal version → SET-IF-NEWER rejects the second (the collision guard).
    const same = aiConfigVersion(new Date('2026-07-14T10:00:00.000Z'));
    assert.equal(same, t1);
  });
});

describe('promptBlocksVersion', () => {
  it('is the newest updated_at across the tenant blocks', () => {
    const rows = [
      { updated_at: new Date('2026-07-01T00:00:00.000Z') },
      { updated_at: new Date('2026-07-14T09:00:00.000Z') },
      { updated_at: new Date('2026-07-10T00:00:00.000Z') },
    ];
    assert.equal(promptBlocksVersion(rows), new Date('2026-07-14T09:00:00.000Z').getTime() * 1000);
  });

  it('is 0 for an empty block set', () => {
    assert.equal(promptBlocksVersion([]), 0);
  });
});

describe('normalizeAiConfig', () => {
  it('coerces non-array restrictions to [] and preserves the rest', () => {
    const out = normalizeAiConfig({
      tone: 'friendly',
      custom_model_id: 'ft:gpt-x',
      is_active: true,
      restrictions: undefined as unknown as string[],
      platform_restrictions: null as unknown as string[],
    });
    assert.deepEqual(out.restrictions, []);
    assert.deepEqual(out.platform_restrictions, []);
    assert.equal(out.tone, 'friendly');
    assert.equal(out.custom_model_id, 'ft:gpt-x');
    assert.equal(out.is_active, true);
  });

  it('preserves already-array restrictions', () => {
    const out = normalizeAiConfig({
      restrictions: ['no medical advice'],
      platform_restrictions: ['no politics'],
    });
    assert.deepEqual(out.restrictions, ['no medical advice']);
    assert.deepEqual(out.platform_restrictions, ['no politics']);
  });
});
