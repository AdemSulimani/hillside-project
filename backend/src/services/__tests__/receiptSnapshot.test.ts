/**
 * Tests for the P2-4 Part 2 receipt-time snapshot (RC-06 / RC-17).
 *
 * All pure/in-process — the module deliberately holds no I/O so the decision surface is testable
 * (the impure loader lives in processInboundMessage). Mirrors the `aiResumePolicy` precedent.
 *
 * The load-bearing guarantee is a NEGATIVE one: the snapshot must never be able to govern a gate.
 * Everything RC-06 gets from it is a RECORD. The suite pins that, plus the two failure modes that
 * would silently break delivery: an absent snapshot (outbox rows pending across a deploy carry no
 * `receiptSnapshot`) and the NaN arithmetic trap that an age-check-first implementation walks into.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReceiptSnapshot,
  compareSnapshotToLive,
  isCachedConfigStale,
  snapshotUsable,
  type LiveGateState,
  type ReceiptSnapshot,
} from '../receiptSnapshot';
import { aiReplyJobDataSchema, buildAIReplyJobData } from '../../jobs/jobTypes';

const CAPTURED_AT = 1_700_000_000_000;
const EVAL_AT = CAPTURED_AT + 8_000;

/** Overrides mirror `buildReceiptSnapshot`'s INPUT shape (which accepts a Date hold), not the
 * output shape (where the hold is already normalized to ISO). */
type SnapshotInput = Parameters<typeof buildReceiptSnapshot>[0];

function snapshot(overrides: Partial<SnapshotInput> = {}): ReceiptSnapshot {
  return buildReceiptSnapshot({
    nowMs: CAPTURED_AT,
    receivedAtMs: CAPTURED_AT - 250,
    aiActive: true,
    aiConfigVersion: 1_700_000_000_000_000,
    channelAiEnabled: true,
    conversationAiPaused: false,
    humanOverrideUntil: null,
    matchCount: 1,
    ...overrides,
  });
}

function live(overrides: Partial<LiveGateState> = {}): LiveGateState {
  return {
    aiActive: true,
    aiConfigVersion: 1_700_000_000_000_000,
    channelAiEnabled: true,
    conversationAiPaused: false,
    humanOverrideUntil: null,
    ...overrides,
  };
}

describe('P2-4 Part 2 — snapshotUsable: absence is a first-class case', () => {
  it('rejects undefined (a job enqueued before the snapshot shipped)', () => {
    assert.equal(snapshotUsable(undefined), false);
  });

  it('rejects an outbox row whose JSONB payload predates the field', () => {
    // What outboxRelay re-hydrates from Postgres for a row pending across the deploy.
    const legacyPayload = {
      tenantId: 't1',
      channelId: 'c1',
      conversationId: 'conv1',
      messageExternalId: 'mid1',
    };
    assert.equal(snapshotUsable((legacyPayload as { receiptSnapshot?: unknown }).receiptSnapshot), false);
  });

  it('rejects a malformed snapshot rather than trusting its falsy fields', () => {
    assert.equal(snapshotUsable({ aiActive: true }), false);
    assert.equal(snapshotUsable({ capturedAtMs: 'nope' }), false);
    assert.equal(snapshotUsable({ capturedAtMs: NaN }), false);
    assert.equal(snapshotUsable(null), false);
  });

  it('accepts a well-formed snapshot', () => {
    assert.equal(snapshotUsable(snapshot()), true);
  });

  it('guards the NaN trap: absence must be checked BEFORE any age arithmetic', () => {
    // The bug this pins: `Date.now() - undefined` is NaN, and `NaN > MAX` is FALSE — so an
    // age-check-first implementation does NOT fall back to live. It proceeds to read
    // `snapshot.aiActive` (undefined → falsy) and the job looks like "AI disabled" → silent drop.
    const missing = undefined as unknown as ReceiptSnapshot;
    assert.equal(Number.isNaN(EVAL_AT - (missing?.capturedAtMs as number)), true);
    assert.equal(EVAL_AT - (missing?.capturedAtMs as number) > 60_000, false);
    // compareSnapshotToLive short-circuits on the shape guard, so none of that arithmetic runs.
    assert.equal(compareSnapshotToLive(missing, live(), EVAL_AT), null);
  });
});

describe('P2-4 Part 2 — compareSnapshotToLive is the RC-06 measurement', () => {
  it('returns null for an absent snapshot (nothing to record; job runs on live reads)', () => {
    assert.equal(compareSnapshotToLive(undefined, live(), EVAL_AT), null);
  });

  it('reports no divergence when the receipt→run window was quiet', () => {
    const result = compareSnapshotToLive(snapshot(), live(), EVAL_AT);
    assert.deepEqual(result?.diverged, []);
  });

  it('names the field a merchant toggled mid-window — the identical-messages-diverge signal', () => {
    const result = compareSnapshotToLive(snapshot(), live({ aiActive: false }), EVAL_AT);
    assert.deepEqual(result?.diverged, ['aiActive']);
    assert.equal(result?.captured.aiActive, true);
    assert.equal(result?.live.aiActive, false);
  });

  it('detects a pause that landed after the message was already accepted', () => {
    const result = compareSnapshotToLive(snapshot(), live({ conversationAiPaused: true }), EVAL_AT);
    assert.deepEqual(result?.diverged, ['conversationAiPaused']);
  });

  it('reports every diverged field, not just the first', () => {
    const result = compareSnapshotToLive(
      snapshot(),
      live({ aiActive: false, channelAiEnabled: false }),
      EVAL_AT,
    );
    assert.deepEqual(result?.diverged.sort(), ['aiActive', 'channelAiEnabled']);
  });

  it('only diffs fields the ladder actually read — an unread gate is not "diverged"', () => {
    // A job dropping at the is_active gate never reads the channel or conversation rows, so
    // reporting channelAiEnabled as diverged would be fabrication.
    const result = compareSnapshotToLive(snapshot(), { aiActive: false }, EVAL_AT);
    assert.deepEqual(result?.diverged, ['aiActive']);
    assert.deepEqual(Object.keys(result?.live ?? {}), ['aiActive']);
  });

  it('measures both halves of the window separately', () => {
    const result = compareSnapshotToLive(snapshot(), live(), EVAL_AT);
    // The non-deliberate hop (webhook → capture) vs the deliberate deferral (capture → eval).
    assert.equal(result?.receipt_to_capture_ms, 250);
    assert.equal(result?.capture_to_eval_ms, 8_000);
  });

  it('reports a null receipt gap rather than a fake 0 when receivedAtMs is absent', () => {
    const result = compareSnapshotToLive(snapshot({ receivedAtMs: null }), live(), EVAL_AT);
    assert.equal(result?.receipt_to_capture_ms, null);
  });
});

describe('P2-4 Part 2 — buildReceiptSnapshot', () => {
  it('normalizes a Date hold to ISO so it compares to the live read by value', () => {
    const hold = new Date(CAPTURED_AT + 600_000);
    const s = snapshot({ humanOverrideUntil: hold });
    assert.equal(s.humanOverrideUntil, hold.toISOString());
    const result = compareSnapshotToLive(s, live({ humanOverrideUntil: hold.toISOString() }), EVAL_AT);
    assert.deepEqual(result?.diverged, []);
  });

  it('treats an unparseable hold as null instead of emitting Invalid Date', () => {
    assert.equal(snapshot({ humanOverrideUntil: 'not-a-date' }).humanOverrideUntil, null);
  });

  it('does NOT carry reply_locale', () => {
    // reply_locale is job-OUTPUT state written by the PREVIOUS turn's reply, with its own
    // reply_locale_updated_at hysteresis anchor. Freezing it at receipt would let a burst read a
    // locale from before the prior turn resolved one — re-introducing exactly the oscillation
    // P2-2's STICKY_LOCALE_SLOT exists to stop. It is not an enablement gate and not an RC-06
    // target; the live read at the detectReplyLanguage call site stays authoritative.
    assert.equal('replyLocale' in snapshot(), false);
  });

  it('carries matchCount so a dual-tenant binding is a query, not archaeology (P1-7/RC-09)', () => {
    assert.equal(snapshot({ matchCount: 2 }).matchCount, 2);
  });

  it('allows a null matchCount rather than fabricating 1 where it cannot be observed', () => {
    // The edit path resolves its channel via findChannelByTypeAndExternalId, which collapses the
    // count. Recording a confident 1 there would be a lie in the one field whose whole purpose is
    // to reveal that the count is NOT 1.
    assert.equal(snapshot({ matchCount: null }).matchCount, null);
  });
});

describe('P2-4 Part 2 — the ai.reply payload contract at the JSONB boundary', () => {
  const base = {
    tenantId: 't1',
    channelId: 'c1',
    conversationId: 'conv1',
    messageExternalId: 'mid1',
  };

  it('parses an outbox row written by a PREVIOUS deploy (no snapshot field)', () => {
    // Rows sit pending across a deploy. The relay must accept them, not dead-letter them — an
    // absent snapshot is a first-class case, and the job simply runs on live reads.
    const parsed = aiReplyJobDataSchema.safeParse(base);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.receiptSnapshot, undefined);
  });

  it('round-trips a payload carrying a snapshot', () => {
    const payload = buildAIReplyJobData({ ...base, traceId: 'tr1', receiptSnapshot: snapshot() });
    const parsed = aiReplyJobDataSchema.safeParse(payload);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.receiptSnapshot?.aiActive, true);
  });

  it('strips a malformed snapshot rather than passing undefined fields to the gates', () => {
    // Trusting it would make `snapshot.aiActive` undefined → falsy → the ledger would record a
    // fabricated "AI was disabled at receipt". Dropping it degrades to the honest absent case.
    const parsed = aiReplyJobDataSchema.safeParse({
      ...base,
      receiptSnapshot: { capturedAtMs: 'garbage' },
    });
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.receiptSnapshot, undefined);
  });

  it('rejects a payload missing a required id — the relay must not dispatch it', () => {
    // These become a thrown error in dispatchRow → recordFailure → retry → dead-letter, rather
    // than a worker receiving falsy ids.
    assert.equal(aiReplyJobDataSchema.safeParse({ ...base, tenantId: undefined }).success, false);
    assert.equal(aiReplyJobDataSchema.safeParse({ ...base, conversationId: '' }).success, false);
  });

  it('accepts a null matchCount inside the snapshot (the edit path cannot observe it)', () => {
    const payload = buildAIReplyJobData({
      ...base,
      receiptSnapshot: snapshot({ matchCount: null }),
    });
    const parsed = aiReplyJobDataSchema.safeParse(payload);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.receiptSnapshot?.matchCount, null);
  });

  it('omits absent optionals instead of emitting explicit undefined keys into JSONB', () => {
    const payload = buildAIReplyJobData(base);
    assert.equal('traceId' in payload, false);
    assert.equal('receiptSnapshot' in payload, false);
  });
});

describe('P2-4 Part 2 — isCachedConfigStale: the ONE governing use (RC-17)', () => {
  it('forces a re-read when the cached config predates the config in force at receipt', () => {
    assert.equal(isCachedConfigStale(1_000, 2_000), true);
  });

  it('accepts a cached config newer than receipt — config may improve, gates may not move', () => {
    // "Decide to answer as of receipt, answer as well as possible now": an edit AFTER receipt is
    // fine to answer WITH. The floor is a lower bound, never a pin.
    assert.equal(isCachedConfigStale(3_000, 2_000), false);
  });

  it('accepts an exactly-equal version', () => {
    assert.equal(isCachedConfigStale(2_000, 2_000), false);
  });

  it('is inert without a snapshot version (flag off / legacy job): never forces a re-read', () => {
    assert.equal(isCachedConfigStale(1_000, 0), false);
  });

  it('is inert on a non-finite version rather than treating NaN as stale', () => {
    assert.equal(isCachedConfigStale(NaN, 2_000), false);
    assert.equal(isCachedConfigStale(1_000, NaN), false);
  });

  it('can only ever make config FRESHER — the safety property that makes governance sound here', () => {
    // aiConfigVersion is updated_at as epoch micros off ONE DB clock, and monotonic. So for every
    // pair, staleness implies the cached value is genuinely older. There is no ordering in which
    // the floor pins a STALER config than the cache already held.
    for (const [cached, floor] of [
      [1, 2],
      [999_999, 1_000_000],
      [0, 1],
    ]) {
      assert.equal(isCachedConfigStale(cached, floor), true, `${cached} < ${floor}`);
    }
    for (const [cached, floor] of [
      [2, 1],
      [1_000_000, 999_999],
      [5, 5],
    ]) {
      assert.equal(isCachedConfigStale(cached, floor), false, `${cached} >= ${floor}`);
    }
  });
});
