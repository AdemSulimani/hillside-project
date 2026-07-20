/**
 * Tests for the sensitive-path fail-closed policy (P0-4, RC-19 / RC-22).
 *
 * RC-19: the whole pre-reply special-path block (cancellation/refund, wrong-product,
 * post-purchase, order-info, escalation) sits inside a single umbrella try/catch that
 * `console.warn('...continuing normal flow')`s and falls through to `generateReply`.
 * Any throw — a classifier transport error, a DB write, a contact lookup — silently
 * downgrades a refund/cancellation demand into an ordinary sales reply, with no alert,
 * no pause, no order flag, and (because the throw is swallowed) no BullMQ retry.
 *
 * Under SENSITIVE_PATH_FAIL_CLOSED the subsystem must fail closed:
 *  - a SENSITIVE detector throw → ESCALATE (holding message + alert + pause), never a
 *    sales reply;
 *  - any other PRE-SEND throw → RETRY (re-throw so BullMQ retries);
 *  - a POST-SEND throw → STOP (never re-throw — a retry would double-send the
 *    already-delivered ack, RC-20 — and never fall through to generateReply, or the
 *    sensitive ack would be followed by a normal sales reply, RC-19 by another door).
 *
 * Flag OFF must be byte-for-byte legacy: every failure kind returns CONTINUE (the
 * umbrella warn + fall-through to a normal reply).
 *
 * `decideSensitivePathAction` is the pure decision core; these tests exercise it in
 * isolation (no network/DB/OpenAI), mirroring the P0-3 gapGateDeterministicFirst split.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideSensitivePathAction,
  decideSensitiveDetectorFailureRoute,
  SensitivePathEscalatedError,
  type SensitivePathFailureKind,
} from '../sensitivePathFailClosed';

// ---------------------------------------------------------------------------
// decideSensitivePathAction — flag OFF preserves legacy fail-OPEN byte-for-byte
// ---------------------------------------------------------------------------

describe('decideSensitivePathAction — flag off (legacy fail-open)', () => {
  const kinds: SensitivePathFailureKind[] = ['detector', 'pre_send', 'post_send'];

  for (const kind of kinds) {
    it(`returns "continue" for a ${kind} failure when failClosed=false`, () => {
      assert.equal(decideSensitivePathAction(kind, false), 'continue');
    });
  }
});

// ---------------------------------------------------------------------------
// decideSensitivePathAction — flag ON fails closed by failure kind
// ---------------------------------------------------------------------------

describe('decideSensitivePathAction — flag on (fail closed)', () => {
  it('escalates a failed SENSITIVE detector instead of a normal reply (RC-19 core)', () => {
    // The refund-during-an-OpenAI-blip scenario: the detector call itself threw, before
    // any side effect ran, so the safe response is to escalate to a human — not a sales reply.
    assert.equal(decideSensitivePathAction('detector', true), 'escalate');
  });

  it('retries a PRE-SEND error so BullMQ re-runs the job (nothing delivered yet)', () => {
    assert.equal(decideSensitivePathAction('pre_send', true), 'retry');
  });

  it('STOPS on a POST-SEND error — no retry (double-send, RC-20) and no fall-through (sales reply after a sensitive ack, RC-19)', () => {
    assert.equal(decideSensitivePathAction('post_send', true), 'stop');
  });
});

// ---------------------------------------------------------------------------
// Truth table — the decision depends only on (kind, failClosed) and is total
// ---------------------------------------------------------------------------

describe('decideSensitivePathAction — full truth table', () => {
  const cases: Array<[SensitivePathFailureKind, boolean, string]> = [
    ['detector', false, 'continue'],
    ['pre_send', false, 'continue'],
    ['post_send', false, 'continue'],
    ['detector', true, 'escalate'],
    ['pre_send', true, 'retry'],
    ['post_send', true, 'stop'],
  ];

  for (const [kind, failClosed, expected] of cases) {
    it(`(${kind}, failClosed=${failClosed}) → ${expected}`, () => {
      assert.equal(decideSensitivePathAction(kind, failClosed), expected);
    });
  }

  it('never returns "retry" once a message is on the wire, at either flag setting', () => {
    // The invariant that keeps the fail-closed re-throw from resurrecting RC-20: a
    // post-send failure must never map to a retry regardless of the flag.
    assert.notEqual(decideSensitivePathAction('post_send', true), 'retry');
    assert.notEqual(decideSensitivePathAction('post_send', false), 'retry');
  });

  it('never falls through to a sales reply after a delivered sensitive ack when the flag is on', () => {
    // The H2 fix: post_send under fail-closed must STOP the job, not continue into
    // generateReply — a refund ack followed by a sales pitch is the exact RC-19 outcome.
    assert.notEqual(decideSensitivePathAction('post_send', true), 'continue');
  });
});

// ---------------------------------------------------------------------------
// decideSensitiveDetectorFailureRoute — F4: provider-caused failures take the
// no-pause degrade floor; everything else keeps the P0-4 behavior byte-for-byte
// ---------------------------------------------------------------------------

describe('decideSensitiveDetectorFailureRoute — full truth table (8 rows)', () => {
  const cases: Array<[boolean, boolean, boolean, 'escalate' | 'degrade' | 'rethrow']> = [
    // [failClosed, providerCaused, degradeModeOn, expected]
    [false, false, false, 'rethrow'],
    [false, false, true, 'rethrow'],
    [false, true, false, 'rethrow'],
    [false, true, true, 'rethrow'], // flag off is legacy fail-open regardless of the floor
    [true, false, false, 'escalate'],
    [true, false, true, 'escalate'], // non-provider bug: conversation-specific, pause is right
    [true, true, false, 'escalate'], // floor off: U4's exact validated behavior
    [true, true, true, 'degrade'], // the Finding-4 scenario: outage + floor on → no pause
  ];

  for (const [failClosed, providerCaused, degradeModeOn, expected] of cases) {
    it(`(failClosed=${failClosed}, providerCaused=${providerCaused}, degradeModeOn=${degradeModeOn}) → ${expected}`, () => {
      assert.equal(
        decideSensitiveDetectorFailureRoute({ failClosed, providerCaused, degradeModeOn }),
        expected,
      );
    });
  }

  it('never degrades when the floor is off — the caps-without-floor RC-19 guard', () => {
    for (const failClosed of [true, false]) {
      for (const providerCaused of [true, false]) {
        assert.notEqual(
          decideSensitiveDetectorFailureRoute({ failClosed, providerCaused, degradeModeOn: false }),
          'degrade',
        );
      }
    }
  });

  it('never escalates (pauses) a provider-caused failure when the floor is on — the Finding-4 fan-out guard', () => {
    assert.notEqual(
      decideSensitiveDetectorFailureRoute({
        failClosed: true,
        providerCaused: true,
        degradeModeOn: true,
      }),
      'escalate',
    );
  });

  it('flag off is byte-for-byte legacy: always rethrow to the umbrella', () => {
    for (const providerCaused of [true, false]) {
      for (const degradeModeOn of [true, false]) {
        assert.equal(
          decideSensitiveDetectorFailureRoute({ failClosed: false, providerCaused, degradeModeOn }),
          'rethrow',
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// SensitivePathEscalatedError — the sentinel the umbrella catch keys on
// ---------------------------------------------------------------------------

describe('SensitivePathEscalatedError', () => {
  it('is an Error identifiable via instanceof (how the umbrella catch routes it)', () => {
    const err = new SensitivePathEscalatedError();
    assert.ok(err instanceof SensitivePathEscalatedError);
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'SensitivePathEscalatedError');
  });

  it('is distinguishable from an ordinary thrown error', () => {
    const ordinary = new Error('OpenAI 503');
    assert.equal(ordinary instanceof SensitivePathEscalatedError, false);
  });
});
