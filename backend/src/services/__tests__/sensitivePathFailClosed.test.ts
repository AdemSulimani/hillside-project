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
 *  - a POST-SEND throw → CONTINUE (never re-throw — a retry would double-send the
 *    already-delivered reply, RC-20).
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

  it('does NOT retry a POST-SEND error — a retry would double-send the reply (RC-20)', () => {
    assert.equal(decideSensitivePathAction('post_send', true), 'continue');
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
    ['post_send', true, 'continue'],
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
