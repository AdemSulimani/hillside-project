/**
 * Tests for the AI auto-resume policy (P0-5, RC-14 / RC-06).
 *
 * RC-14: no pause has an automatic re-enable — resolution defaults to leaving `ai_paused`
 * on, so a healthy conversation goes permanently silent the moment any guard escalates.
 *
 * Under AI_AUTO_RESUME:
 *  - resolving a NON-sensitive alert without an explicit resume_ai resumes the AI;
 *  - sensitive reasons (cancellation/refund/post-purchase) never auto-resume;
 *  - a legacy NULL-reason pause requires explicit resume;
 *  - a new inbound clears a rate_limit_exceeded pause only when the counter has rolled
 *    over, no open sensitive alert exists, and no human hold is active.
 *
 * Flag OFF must be byte-for-byte legacy: resume only on an explicit resume_ai === true.
 *
 * These exercise the PURE decision core in isolation (no DB/Redis), mirroring the P0-4
 * sensitivePathFailClosed split.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canDefaultResumeConversation,
  shouldResumeOnResolve,
  shouldAutoResumeRateLimitPause,
  isSensitiveAlertReason,
  SENSITIVE_ALERT_REASONS,
} from '../aiResumePolicy';

// ---------------------------------------------------------------------------
// isSensitiveAlertReason
// ---------------------------------------------------------------------------

describe('isSensitiveAlertReason', () => {
  for (const reason of SENSITIVE_ALERT_REASONS) {
    it(`treats ${reason} as sensitive`, () => {
      assert.equal(isSensitiveAlertReason(reason), true);
    });
  }

  it('treats a non-sensitive reason as not sensitive', () => {
    assert.equal(isSensitiveAlertReason('usage_question_unanswered'), false);
    assert.equal(isSensitiveAlertReason('product_question_unanswered'), false);
    assert.equal(isSensitiveAlertReason('rate_limit_exceeded'), false);
  });

  it('treats null/undefined as not sensitive', () => {
    assert.equal(isSensitiveAlertReason(null), false);
    assert.equal(isSensitiveAlertReason(undefined), false);
  });
});

// ---------------------------------------------------------------------------
// shouldResumeOnResolve — explicit resume_ai always wins, regardless of flag/reason
// ---------------------------------------------------------------------------

describe('shouldResumeOnResolve — explicit resume_ai wins', () => {
  it('explicit true resumes even for a sensitive reason and flag off', () => {
    assert.equal(shouldResumeOnResolve('refund_request', true, false), true);
    assert.equal(shouldResumeOnResolve('usage_question_unanswered', true, true), true);
  });

  it('explicit false stays paused even for a non-sensitive reason and flag on', () => {
    assert.equal(shouldResumeOnResolve('usage_question_unanswered', false, true), false);
    assert.equal(shouldResumeOnResolve('product_question_unanswered', false, true), false);
  });
});

// ---------------------------------------------------------------------------
// shouldResumeOnResolve — omitted resume_ai (the default-close path)
// ---------------------------------------------------------------------------

describe('shouldResumeOnResolve — omitted resume_ai, flag OFF (legacy)', () => {
  it('never resumes on omission when the flag is off, regardless of reason', () => {
    assert.equal(shouldResumeOnResolve('usage_question_unanswered', undefined, false), false);
    assert.equal(shouldResumeOnResolve('refund_request', undefined, false), false);
    assert.equal(shouldResumeOnResolve(null, undefined, false), false);
  });
});

describe('shouldResumeOnResolve — omitted resume_ai, flag ON', () => {
  it('resumes for a non-sensitive reason (the dead-end fix)', () => {
    assert.equal(shouldResumeOnResolve('usage_question_unanswered', undefined, true), true);
    assert.equal(shouldResumeOnResolve('product_question_unanswered', undefined, true), true);
    assert.equal(shouldResumeOnResolve('low_confidence', undefined, true), true);
  });

  for (const reason of SENSITIVE_ALERT_REASONS) {
    it(`stays paused for the sensitive reason ${reason}`, () => {
      assert.equal(shouldResumeOnResolve(reason, undefined, true), false);
    });
  }

  it('stays paused for a legacy/unknown NULL reason (require explicit)', () => {
    assert.equal(shouldResumeOnResolve(null, undefined, true), false);
    assert.equal(shouldResumeOnResolve(undefined, undefined, true), false);
  });
});

// ---------------------------------------------------------------------------
// shouldAutoResumeRateLimitPause — all conjuncts required
// ---------------------------------------------------------------------------

describe('shouldAutoResumeRateLimitPause', () => {
  // The one input combination that SHOULD resume.
  const ok = {
    autoResumeEnabled: true,
    aiPaused: true,
    reason: 'rate_limit_exceeded' as string | null,
    rateKeyExists: false,
    hasOpenSensitiveAlert: false,
    humanOverrideActive: false,
  };

  it('resumes when the counter has rolled over, no sensitive alert, no human hold', () => {
    assert.equal(shouldAutoResumeRateLimitPause(ok), true);
  });

  it('does NOT resume when the flag is off', () => {
    assert.equal(shouldAutoResumeRateLimitPause({ ...ok, autoResumeEnabled: false }), false);
  });

  it('does NOT resume when the conversation is not paused', () => {
    assert.equal(shouldAutoResumeRateLimitPause({ ...ok, aiPaused: false }), false);
  });

  it('does NOT resume for a non-rate-limit pause reason', () => {
    assert.equal(shouldAutoResumeRateLimitPause({ ...ok, reason: 'usage_question_unanswered' }), false);
    assert.equal(shouldAutoResumeRateLimitPause({ ...ok, reason: null }), false);
  });

  it('does NOT resume while the rate counter key still exists (window not rolled over)', () => {
    assert.equal(shouldAutoResumeRateLimitPause({ ...ok, rateKeyExists: true }), false);
  });

  it('does NOT resume when an open sensitive alert exists', () => {
    assert.equal(shouldAutoResumeRateLimitPause({ ...ok, hasOpenSensitiveAlert: true }), false);
  });

  it('does NOT resume while a human hold is active (would wipe human_override_until)', () => {
    assert.equal(shouldAutoResumeRateLimitPause({ ...ok, humanOverrideActive: true }), false);
  });
});

// ---------------------------------------------------------------------------
// canDefaultResumeConversation — the conversation-state guard for a default
// (omitted resume_ai) resolve. shouldResumeOnResolve only sees the ALERT's
// reason; this guard is what keeps a plain Close from un-pausing a manual
// pause or resuming past another open sensitive alert.
// ---------------------------------------------------------------------------

describe('canDefaultResumeConversation', () => {
  const automatedPause = {
    aiPaused: true,
    aiPausedAt: new Date('2026-07-01T10:00:00Z'),
    hasOpenSensitiveAlert: false,
  };

  it('resumes an automated pause with no open sensitive alert', () => {
    assert.equal(canDefaultResumeConversation(automatedPause), true);
  });

  it('never un-pauses a MANUAL/legacy pause (ai_paused_at NULL — human-owned or pre-migration)', () => {
    // toggleAiPaused deliberately leaves ai_paused_at NULL so an owner's explicit
    // "AI off" survives staff closing an unrelated alert.
    assert.equal(canDefaultResumeConversation({ ...automatedPause, aiPausedAt: null }), false);
  });

  it('never resumes past another OPEN sensitive alert on the same conversation', () => {
    // Closing a non-sensitive alert while a refund_request is still open must not
    // reactivate the AI mid-refund — mirrors the rate-limit auto-expiry conjunct.
    assert.equal(
      canDefaultResumeConversation({ ...automatedPause, hasOpenSensitiveAlert: true }),
      false,
    );
  });

  it('is a no-op for a conversation that is not paused (avoids clearing an active human hold)', () => {
    // setConversationAiPaused(false) also wipes human_override_until; a default resolve
    // of an alert on an unpaused conversation must not issue that write.
    assert.equal(canDefaultResumeConversation({ ...automatedPause, aiPaused: false }), false);
  });
});
