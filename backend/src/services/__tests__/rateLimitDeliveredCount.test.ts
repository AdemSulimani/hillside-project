/**
 * Tests for the delivered-only rate-count predicates (P0-6, RC-18).
 *
 * RC-18: the 25/h per-conversation limiter INCRs once per BullMQ job ATTEMPT, before the
 * enablement gates and the staleness guard, so retries / stale-skipped / disabled-AI /
 * rescheduled jobs all burn budget without producing a reply. A busy conversation trips
 * 25 on phantom increments → persistent `ai_paused` + `rate_limit_exceeded` → (RC-14)
 * permanent silence.
 *
 * Under RATE_LIMIT_COUNT_DELIVERED_ONLY the budget counts only real delivered replies,
 * keyed idempotently on the inbound message id, with the cap enforced by a read-only
 * pre-send check. Flag OFF must be byte-for-byte legacy: nothing counts post-send (the
 * pre-gate INCR keeps ownership).
 *
 * These exercise the PURE decision core in isolation (no Redis), mirroring the P0-4
 * sensitivePathFailClosed split. The atomic "not already counted" idempotency lives in
 * the Lua marker in `jobs/processAIReply.ts`, not in these functions.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldCountDeliveredReply,
  isOverDeliveredRateLimit,
  rateCountedMarkerKey,
} from '../rateLimitDeliveredCount';

// ---------------------------------------------------------------------------
// shouldCountDeliveredReply — flag OFF never counts post-send (legacy owns it)
// ---------------------------------------------------------------------------

describe('shouldCountDeliveredReply — flag off (legacy pre-gate INCR owns counting)', () => {
  it('never counts post-send when the flag is off, even for a delivered reply', () => {
    assert.equal(
      shouldCountDeliveredReply({ countDeliveredOnly: false, sendSucceeded: true }),
      false,
    );
  });

  it('never counts post-send when the flag is off and nothing was delivered', () => {
    assert.equal(
      shouldCountDeliveredReply({ countDeliveredOnly: false, sendSucceeded: false }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// shouldCountDeliveredReply — flag ON counts iff the reply was delivered
// ---------------------------------------------------------------------------

describe('shouldCountDeliveredReply — flag on (delivered-only)', () => {
  it('counts a delivered reply', () => {
    assert.equal(
      shouldCountDeliveredReply({ countDeliveredOnly: true, sendSucceeded: true }),
      true,
    );
  });

  it('does NOT count when the reply was not delivered (the RC-18 phantom case)', () => {
    // A stale/disabled/rescheduled job never reaches a successful send, so it must not
    // burn budget.
    assert.equal(
      shouldCountDeliveredReply({ countDeliveredOnly: true, sendSucceeded: false }),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// shouldCountDeliveredReply — full truth table (total function of two booleans)
// ---------------------------------------------------------------------------

describe('shouldCountDeliveredReply — full truth table', () => {
  const cases: Array<[boolean, boolean, boolean]> = [
    // [countDeliveredOnly, sendSucceeded, expected]
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ];

  for (const [countDeliveredOnly, sendSucceeded, expected] of cases) {
    it(`(countDeliveredOnly=${countDeliveredOnly}, sendSucceeded=${sendSucceeded}) → ${expected}`, () => {
      assert.equal(
        shouldCountDeliveredReply({ countDeliveredOnly, sendSucceeded }),
        expected,
      );
    });
  }
});

// ---------------------------------------------------------------------------
// isOverDeliveredRateLimit — cap boundary reproduces the legacy 25-delivered cap
// ---------------------------------------------------------------------------

describe('isOverDeliveredRateLimit — cap boundary', () => {
  const MAX = 25;

  it('allows the reply when no replies have been delivered yet', () => {
    assert.equal(isOverDeliveredRateLimit(0, MAX), false);
  });

  it('allows the 25th reply (24 already delivered)', () => {
    // 24 delivered so far → this is the 25th → allowed. After it sends, the counter → 25.
    assert.equal(isOverDeliveredRateLimit(24, MAX), false);
  });

  it('pauses the 26th reply (25 already delivered) — cap enforced', () => {
    assert.equal(isOverDeliveredRateLimit(25, MAX), true);
  });

  it('stays over the cap beyond the boundary', () => {
    assert.equal(isOverDeliveredRateLimit(26, MAX), true);
  });
});

// ---------------------------------------------------------------------------
// rateCountedMarkerKey — stable per-inbound key (coalesces retries)
// ---------------------------------------------------------------------------

describe('rateCountedMarkerKey', () => {
  it('builds the per-inbound marker key from conversation + inbound id', () => {
    assert.equal(
      rateCountedMarkerKey('conv-1', 'mid_abc'),
      'ai_rate_counted:conv-1:mid_abc',
    );
  });

  it('is identical for the same inbound across retries (so retries coalesce to one count)', () => {
    assert.equal(
      rateCountedMarkerKey('conv-9', 'wamid.XYZ'),
      rateCountedMarkerKey('conv-9', 'wamid.XYZ'),
    );
  });

  it('differs across distinct inbound messages of the same conversation', () => {
    assert.notEqual(
      rateCountedMarkerKey('conv-9', 'mid_1'),
      rateCountedMarkerKey('conv-9', 'mid_2'),
    );
  });
});
