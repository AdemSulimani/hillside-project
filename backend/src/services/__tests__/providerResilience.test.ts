/**
 * P2-6 (RC-19/RC-04) — the provider-resilience pure core: breaker decision table, breaker state
 * machine, failure classification, and the turn store / degradation verdict.
 *
 * Every assertion here is a pure function or an injected-clock state machine — no `process.env`
 * mutation, no live provider, no Redis, and NOTHING SLEEPS. The repo has no fake timers
 * (`t.mock.timers` is unused everywhere); the house answer is to inject the clock as a value, as
 * `webhookDelivery.test.ts` does with `nowMs`. Here the clock is a ctor argument and cooldown is
 * tested by advancing a local variable.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import {
  AI_QUEUE_BACKOFF_BASE_MS,
  ProviderBreaker,
  ProviderUnavailableError,
  breakerCooldownOutrunsRetries,
  classifyProviderError,
  countsTowardBreaker,
  decideBreakerAction,
  enforcementWithoutFloor,
  shouldDegradeTurn,
  summarizeTurnFailures,
  type BreakerMode,
  type BreakerState,
  type BreakerTransition,
  type ProviderFailure,
  type ProviderPosture,
} from '../providerResilience';

// ---------------------------------------------------------------------------
// decideBreakerAction — the full 3 modes x 3 states matrix.
// ---------------------------------------------------------------------------

describe('decideBreakerAction — the mode x state matrix', () => {
  const STATES: BreakerState[] = ['closed', 'open', 'half_open'];

  it('off never rejects, in any state', () => {
    for (const state of STATES) {
      assert.equal(decideBreakerAction(state, 'off', 0, 1), 'allow', `state=${state}`);
    }
  });

  // THE bake-in guarantee. Asserted as an explicit equality per state rather than "does not throw":
  // an absence-of-throw assertion passes just as happily if the check is a no-op for EVERY mode,
  // including `on` — which would pin nothing at all.
  it('monitor never rejects, in any state (the audit-mandated bake-in window)', () => {
    for (const state of STATES) {
      assert.equal(decideBreakerAction(state, 'monitor', 0, 1), 'allow', `state=${state}`);
    }
    // And it differs from `on` exactly where it matters — otherwise monitor mode is meaningless.
    assert.notEqual(
      decideBreakerAction('open', 'monitor', 0, 1),
      decideBreakerAction('open', 'on', 0, 1),
    );
  });

  it('on: closed allows, open rejects', () => {
    assert.equal(decideBreakerAction('closed', 'on', 0, 1), 'allow');
    assert.equal(decideBreakerAction('open', 'on', 0, 1), 'reject');
  });

  it('on: half_open admits up to maxProbes, then rejects the rest', () => {
    assert.equal(decideBreakerAction('half_open', 'on', 0, 1), 'probe');
    assert.equal(decideBreakerAction('half_open', 'on', 1, 1), 'reject');
    assert.equal(decideBreakerAction('half_open', 'on', 1, 3), 'probe');
    assert.equal(decideBreakerAction('half_open', 'on', 3, 3), 'reject');
  });
});

// ---------------------------------------------------------------------------
// Failure classification — cause comes from the WRAPPER's bookkeeping, not the error.
// ---------------------------------------------------------------------------

describe('classifyProviderError', () => {
  it('5xx is a provider failure', () => {
    assert.equal(classifyProviderError({ status: 503 }, false), 'provider_error');
    assert.equal(classifyProviderError({ status: 500 }, false), 'provider_error');
  });

  // A 429 means the provider is UP and throttling our own burst. Counting it would let a 5k-product
  // backfill or a bulk import hitting the org TPM limit open the CUSTOMER REPLY path's breaker.
  it('429 is recorded but is NOT provider ill-health', () => {
    assert.equal(classifyProviderError({ status: 429 }, false), 'rate_limit');
    assert.equal(countsTowardBreaker('rate_limit'), false);
  });

  it('4xx is a malformed request — says nothing about the provider, so it is not recorded', () => {
    assert.equal(classifyProviderError({ status: 400 }, false), null);
    assert.equal(classifyProviderError({ status: 404 }, false), null);
  });

  /**
   * The crux: the SDK throws the IDENTICAL APIUserAbortError (status === undefined) whether OUR
   * deadline fired or the CALLER's own signal did. Only the wrapper knows which, so only the
   * wrapper's flag may decide. Getting this wrong means a slow fan-out-heavy turn opens the breaker
   * against a provider that was never down — degradation causing degradation.
   *
   * REAL SDK instances, never a fabricated `{name:'APIUserAbortError'}`. That fabrication is the
   * one shape the SDK does NOT produce, and hand-rolling it is what let a live bug sail through a
   * green suite: `APIUserAbortError` never assigns `this.name`, so a real instance inherits
   * `Error.prototype.name` and reports `'Error'`. Only `constructor.name` identifies it.
   */
  it('an abort is classified by OUR flag, not by the error (identical errors, opposite verdicts)', () => {
    const abortErr = new OpenAI.APIUserAbortError({});
    assert.equal(abortErr.name, 'Error', 'documents the trap: the SDK does NOT set .name');

    assert.equal(classifyProviderError(abortErr, true), 'call_timeout');
    assert.equal(classifyProviderError(abortErr, false), null);
  });

  /**
   * The regression guard, stated as the behaviour that actually matters.
   *
   * P1-4's `EMBEDDING_QUERY_TIMEOUT_MS` (5s, on by default) aborts routinely and is DESIGNED to be
   * invisible: it degrades semantic retrieval to lexical and the reply proceeds. Misread that abort
   * as a provider failure and the degradation gate throws away a perfectly good reply and escalates
   * — on a completely healthy provider.
   */
  it("a caller's own abort (e.g. P1-4's 5s embedding timeout) is NOT a provider signal", () => {
    assert.equal(classifyProviderError(new OpenAI.APIUserAbortError({}), false), null);
  });

  it('real SDK error classes classify correctly — not just hand-made shapes', () => {
    const headers = new Headers();
    assert.equal(
      classifyProviderError(new OpenAI.RateLimitError(429, undefined, 'rate limited', headers), false),
      'rate_limit',
    );
    assert.equal(
      classifyProviderError(new OpenAI.InternalServerError(500, undefined, 'boom', headers), false),
      'provider_error',
    );
    assert.equal(
      classifyProviderError(new OpenAI.APIConnectionError({ message: 'econnreset' }), false),
      'provider_error',
    );
    // Node's native abort is a DOMException named 'AbortError' — that one DOES carry .name.
    assert.equal(classifyProviderError(new DOMException('aborted', 'AbortError'), false), null);
  });

  it('a connection error with no status is a provider failure', () => {
    assert.equal(classifyProviderError(new Error('socket hang up'), false), 'provider_error');
  });

  it('a ProviderUnavailableError reports its own cause', () => {
    assert.equal(classifyProviderError(new ProviderUnavailableError('breaker_open', 'chat'), false), 'breaker_open');
  });

  it('only provider_error and call_timeout count toward the breaker', () => {
    assert.equal(countsTowardBreaker('provider_error'), true);
    assert.equal(countsTowardBreaker('call_timeout'), true);
    // Our own policy outputs. Counting these would make the breaker feed on itself.
    assert.equal(countsTowardBreaker('turn_starved'), false);
    assert.equal(countsTowardBreaker('breaker_open'), false);
  });
});

// ---------------------------------------------------------------------------
// The state machine — injected clock, nothing sleeps.
// ---------------------------------------------------------------------------

function makeBreaker(opts: { failureThreshold?: number; cooldownMs?: number; halfOpenProbes?: number } = {}) {
  let t = 1_000_000;
  const transitions: BreakerTransition[] = [];
  const breaker = new ProviderBreaker({
    failureThreshold: opts.failureThreshold ?? 3,
    cooldownMs: opts.cooldownMs ?? 5_000,
    halfOpenProbes: opts.halfOpenProbes ?? 1,
    now: () => t,
    onTransition: (tr) => transitions.push(tr),
  });
  return { breaker, transitions, advance: (ms: number) => { t += ms; } };
}

describe('ProviderBreaker state machine', () => {
  it('opens only after `failureThreshold` consecutive failures', () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure('chat', 'provider_error', 'on');
    breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(breaker.stateOf('chat'), 'closed');
    breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(breaker.stateOf('chat'), 'open');
    assert.deepEqual(transitions.map((t) => [t.from, t.to]), [['closed', 'open']]);
  });

  it('a success resets the streak, so intermittent errors never open it', () => {
    const { breaker } = makeBreaker({ failureThreshold: 3 });
    breaker.recordFailure('chat', 'provider_error', 'on');
    breaker.recordFailure('chat', 'provider_error', 'on');
    breaker.recordSuccess('chat', 'on');
    breaker.recordFailure('chat', 'provider_error', 'on');
    breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(breaker.stateOf('chat'), 'closed');
  });

  it('non-counting causes never open it, however many arrive', () => {
    const { breaker } = makeBreaker({ failureThreshold: 2 });
    for (let i = 0; i < 20; i++) breaker.recordFailure('chat', 'rate_limit', 'on');
    for (let i = 0; i < 20; i++) breaker.recordFailure('chat', 'turn_starved', 'on');
    assert.equal(breaker.stateOf('chat'), 'closed');
  });

  it('open → half_open once the cooldown elapses (read-driven, no timer)', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 5_000 });
    breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(breaker.stateOf('chat'), 'open');

    advance(4_999);
    assert.equal(breaker.stateOf('chat'), 'open', 'still open just before the cooldown');

    advance(1);
    assert.equal(breaker.stateOf('chat'), 'half_open', 'half-open exactly at the cooldown');
  });

  it('a successful half-open probe closes it', () => {
    const { breaker, advance, transitions } = makeBreaker({ failureThreshold: 1, cooldownMs: 5_000 });
    breaker.recordFailure('chat', 'provider_error', 'on');
    advance(5_000);
    assert.equal(breaker.decide('chat', 'on'), 'probe');
    breaker.recordSuccess('chat', 'on');
    assert.equal(breaker.stateOf('chat'), 'closed');
    assert.deepEqual(transitions.map((t) => t.to), ['open', 'half_open', 'closed']);
  });

  /**
   * The flap guard. The wrapper records a success for EVERY resolved call, and under load there are
   * always calls that passed `decide` while the breaker was still closed and land after it opened
   * (the AI worker runs 5 jobs concurrently; one turn fans ~5 classifiers out via Promise.all; the
   * breaker is process-wide). Such a straggler is not evidence of recovery — it predates the
   * evidence that opened the breaker.
   *
   * Letting it close makes a PARTIAL outage flap open→closed→open forever: the breaker keeps
   * dialing a sick provider and fires a Sentry event on every flap. The existing "a successful
   * half-open probe closes it" case cannot catch this — it goes through `decide → probe`, so it
   * only ever exercises `half_open`.
   */
  it('a straggler success does NOT close an OPEN breaker (only a half-open probe may)', () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 3, cooldownMs: 5_000 });
    for (let i = 0; i < 3; i++) breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(breaker.stateOf('chat'), 'open');

    // An in-flight call from before the outage evidence now resolves.
    breaker.recordSuccess('chat', 'on');

    assert.equal(breaker.stateOf('chat'), 'open', 'still open — the cooldown was not skipped');
    assert.equal(breaker.decide('chat', 'on'), 'reject', 'and we are still not dialing');
    assert.deepEqual(transitions.map((t) => t.to), ['open'], 'no flap, no second Sentry event');
  });

  it('a failed half-open probe re-opens immediately and restarts the cooldown', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 3, cooldownMs: 5_000 });
    for (let i = 0; i < 3; i++) breaker.recordFailure('chat', 'provider_error', 'on');
    advance(5_000);
    assert.equal(breaker.stateOf('chat'), 'half_open');

    // A single failure re-opens — it does NOT need another full `failureThreshold`.
    breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(breaker.stateOf('chat'), 'open');
    advance(4_999);
    assert.equal(breaker.stateOf('chat'), 'open', 'the cooldown restarted from the probe failure');
  });

  it('half_open admits only `halfOpenProbes` at a time', () => {
    const { breaker, advance } = makeBreaker({ failureThreshold: 1, cooldownMs: 1_000, halfOpenProbes: 1 });
    breaker.recordFailure('chat', 'provider_error', 'on');
    advance(1_000);
    assert.equal(breaker.decide('chat', 'on'), 'probe');
    breaker.probeStarted('chat');
    assert.equal(breaker.decide('chat', 'on'), 'reject', 'a second concurrent probe is refused');
    breaker.probeSettled('chat');
    assert.equal(breaker.decide('chat', 'on'), 'probe');
  });

  // chat and embedding are different endpoints with different load profiles: an embedding backfill
  // saturating its own quota must not fast-fail customer replies.
  it('kinds are isolated — opening chat leaves embedding closed', () => {
    const { breaker } = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure('chat', 'provider_error', 'on');
    assert.equal(breaker.stateOf('chat'), 'open');
    assert.equal(breaker.stateOf('embedding'), 'closed');
    assert.equal(breaker.decide('embedding', 'on'), 'allow');
  });

  /**
   * The rollback guarantee, and it is about ALERTING as much as behaviour.
   *
   * `decide` already returns 'allow' for every state when off, so an `off` breaker that still ran
   * its machine would not fast-fail anything — the behaviour would look fine. But it WOULD fire
   * onTransition → logger.error → a Sentry event for a feature the operator has switched off, and
   * report `open` in the ledger snapshot. Found by driving the real client with every knob at its
   * default: "flag off changes nothing" has to include the pager.
   */
  it('off is FULLY inert — no state change, no transition, no alert', () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 2 });
    for (let i = 0; i < 20; i++) breaker.recordFailure('chat', 'provider_error', 'off');
    assert.equal(breaker.stateOf('chat'), 'closed', 'the machine never ran');
    assert.deepEqual(transitions, [], 'and nothing was reported to Sentry');
    assert.equal(breaker.decide('chat', 'off'), 'allow');
  });

  // monitor must run the machine (that IS the bake-in signal) while never changing behaviour.
  it('monitor records transitions but still allows every call', () => {
    const { breaker, transitions } = makeBreaker({ failureThreshold: 2 });
    breaker.recordFailure('chat', 'provider_error', 'monitor');
    breaker.recordFailure('chat', 'provider_error', 'monitor');
    assert.equal(breaker.stateOf('chat'), 'open', 'the machine ran');
    assert.equal(breaker.decide('chat', 'monitor'), 'allow', 'but nothing was fast-failed');
    assert.equal(
      transitions[transitions.length - 1]?.observedOnly,
      true,
      'flagged as observed-only for the operator',
    );
  });

  it('a throwing onTransition never breaks the call that caused it', () => {
    const breaker = new ProviderBreaker({
      failureThreshold: 1,
      cooldownMs: 1_000,
      halfOpenProbes: 1,
      now: () => 0,
      onTransition: () => { throw new Error('reporting blew up'); },
    });
    assert.doesNotThrow(() => breaker.recordFailure('chat', 'provider_error', 'on'));
    assert.equal(breaker.stateOf('chat'), 'open');
  });

  it('snapshot is scalars only — safe for the ledger and logs', () => {
    const { breaker } = makeBreaker({ failureThreshold: 1 });
    breaker.recordFailure('chat', 'provider_error', 'on');
    breaker.recordSuccess('embedding', 'on');
    assert.deepEqual(breaker.snapshot(), { chat: 'open', embedding: 'closed' });
  });
});

// ---------------------------------------------------------------------------
// The degradation verdict.
// ---------------------------------------------------------------------------

describe('shouldDegradeTurn', () => {
  const failure: ProviderFailure = { kind: 'chat', cause: 'provider_error' };

  it('flag off ⇒ never degrades, however bad the turn was (byte-for-byte legacy)', () => {
    assert.equal(shouldDegradeTurn([failure, failure], false), false);
  });

  it('flag on + a clean turn ⇒ untouched', () => {
    assert.equal(shouldDegradeTurn([], true), false);
  });

  it('flag on + ANY failure ⇒ degrade', () => {
    assert.equal(shouldDegradeTurn([failure], true), true);
  });

  // Every cause degrades, including the ones the breaker ignores. A turn whose guards were skipped
  // because of a 429 is exactly as unguarded as one skipped by an outage — the breaker cares about
  // provider health; the floor cares about whether this reply can be trusted.
  it('degrades on causes the breaker deliberately does not count', () => {
    for (const cause of ['rate_limit', 'turn_starved', 'breaker_open'] as const) {
      assert.equal(shouldDegradeTurn([{ kind: 'chat', cause }], true), true, cause);
    }
  });

  it('summarizeTurnFailures counts by cause (scalars only, no PII)', () => {
    assert.deepEqual(
      summarizeTurnFailures([
        { kind: 'chat', cause: 'provider_error' },
        { kind: 'chat', cause: 'provider_error' },
        { kind: 'embedding', cause: 'turn_starved' },
      ]),
      { provider_error: 2, turn_starved: 1 },
    );
  });
});

/**
 * The config-combination rules the boot posture warns on. Pure + tested rather than inline
 * conditions inside a console.warn — the split P2-7 uses for detect/applyMode, and the reason those
 * warnings are a contract instead of a string somebody can quietly weaken.
 */
describe('provider posture safety rules', () => {
  const OFF: ProviderPosture = {
    degradeEnabled: false,
    breakerMode: 'off',
    callCapMs: 0,
    turnBudgetMs: 0,
    breakerCooldownMs: 5_000,
  };

  describe('enforcementWithoutFloor — the combination worse than shipping nothing', () => {
    it('all defaults ⇒ no warning (nothing is enforcing)', () => {
      assert.equal(enforcementWithoutFloor(OFF), false);
    });

    // Each enforcement knob ALONE is enough to make RC-19 fire faster: it aborts the refund
    // detector, the umbrella falls through, and a sales reply answers a refund demand.
    it('ANY enforcement knob without the floor ⇒ warn', () => {
      assert.equal(enforcementWithoutFloor({ ...OFF, callCapMs: 45_000 }), true, 'call cap');
      assert.equal(enforcementWithoutFloor({ ...OFF, turnBudgetMs: 120_000 }), true, 'turn budget');
      assert.equal(enforcementWithoutFloor({ ...OFF, breakerMode: 'on' }), true, 'breaker on');
    });

    it('the documented Step 1 pairing (caps WITH the floor) ⇒ no warning', () => {
      assert.equal(
        enforcementWithoutFloor({
          ...OFF,
          degradeEnabled: true,
          callCapMs: 45_000,
          turnBudgetMs: 120_000,
          breakerMode: 'on',
        }),
        false,
      );
    });

    // monitor never fast-fails, so it is not enforcement — that is the whole point of the bake-in
    // window, and warning on it would train operators to ignore the warning.
    it('monitor is not enforcement, so it needs no floor', () => {
      assert.equal(enforcementWithoutFloor({ ...OFF, breakerMode: 'monitor' }), false);
    });

    it('the floor alone (Step 1 with no caps) ⇒ no warning — that is the recommended first step', () => {
      assert.equal(enforcementWithoutFloor({ ...OFF, degradeEnabled: true }), false);
    });
  });

  describe('breakerCooldownOutrunsRetries — the DLQ-storm guard', () => {
    it('the default 5s cooldown clears aiQueue\'s 10s backoff base', () => {
      assert.equal(breakerCooldownOutrunsRetries({ ...OFF, breakerMode: 'on', breakerCooldownMs: 5_000 }), false);
    });

    it('a cooldown at/over the backoff base ⇒ warn (every retry would fast-fail, then DLQ)', () => {
      assert.equal(
        breakerCooldownOutrunsRetries({ ...OFF, breakerMode: 'on', breakerCooldownMs: AI_QUEUE_BACKOFF_BASE_MS }),
        true,
      );
      assert.equal(
        breakerCooldownOutrunsRetries({ ...OFF, breakerMode: 'on', breakerCooldownMs: 30_000 }),
        true,
        'the audit-shaped 30s cooldown spans both retries exactly',
      );
    });

    // Nothing fast-fails unless the breaker is enforcing, so the cooldown cannot burn a retry.
    it('off/monitor never warn, whatever the cooldown', () => {
      assert.equal(breakerCooldownOutrunsRetries({ ...OFF, breakerCooldownMs: 600_000 }), false);
      assert.equal(
        breakerCooldownOutrunsRetries({ ...OFF, breakerMode: 'monitor', breakerCooldownMs: 600_000 }),
        false,
      );
    });
  });
});


describe('P2-6-F2: turn_truncated is recorded but never counted', () => {
  it('countsTowardBreaker(turn_truncated) is false', () => {
    assert.equal(countsTowardBreaker('turn_truncated'), false);
  });

  it('a storm of turn_truncated failures cannot open the breaker', () => {
    const breaker = new ProviderBreaker({
      failureThreshold: 3,
      cooldownMs: 5_000,
      halfOpenProbes: 1,
      now: () => 1_000,
    });
    for (let i = 0; i < 20; i++) breaker.recordFailure('chat', 'turn_truncated', 'on');
    assert.notEqual(breaker.decide('chat', 'on'), 'reject');
  });
});
