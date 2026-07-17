/**
 * P1-2 (RC-20/21/18): unit coverage for the pure job-failure classifier that decides
 * transient-vs-terminal-vs-stalled and whether to dead-letter now. The DB write, alerts, and Sentry
 * wiring live in the failure handler; here we lock the decision logic that drives all of it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyJobFailure, STALLED_MESSAGE } from '../../jobs/failureClassifier';

describe('classifyJobFailure — stalled (C-88 regression guard)', () => {
  it('classifies a stalled/SIGKILL failure as stalled+deadLetter even below the attempt cap', () => {
    // The exact bug: BullMQ fails a SIGKILLed job as UnrecoverableError with attemptsMade=1 < 3.
    const v = classifyJobFailure({
      failedReason: STALLED_MESSAGE,
      errorName: 'UnrecoverableError',
      errorMessage: STALLED_MESSAGE,
      attemptsMade: 1,
      maxAttempts: 3,
    });
    assert.equal(v.classification, 'stalled');
    assert.equal(v.deadLetter, true);
  });

  it('the stalled message wins over the UnrecoverableError name (ordering)', () => {
    const v = classifyJobFailure({
      errorName: 'UnrecoverableError',
      errorMessage: `Error: ${STALLED_MESSAGE}`,
      attemptsMade: 1,
      maxAttempts: 5,
    });
    assert.equal(v.classification, 'stalled');
    assert.equal(v.deadLetter, true);
  });
});

describe('classifyJobFailure — UnrecoverableError (BullMQ will not retry)', () => {
  it('dead-letters immediately regardless of attempt count', () => {
    const v = classifyJobFailure({
      errorName: 'UnrecoverableError',
      errorMessage: 'unknown channel type',
      attemptsMade: 1,
      maxAttempts: 3,
    });
    assert.equal(v.classification, 'terminal');
    assert.equal(v.deadLetter, true);
  });
});

describe('classifyJobFailure — transient (retry, DLQ only at exhaustion)', () => {
  it('a 503 at attempt 1 retries (no dead-letter)', () => {
    const v = classifyJobFailure({
      errorMessage: 'Request failed with status code 503',
      errorName: 'AxiosError',
      attemptsMade: 1,
      maxAttempts: 3,
    });
    assert.equal(v.classification, 'transient');
    assert.equal(v.deadLetter, false);
  });

  it('the same 503 at exhaustion dead-letters', () => {
    const v = classifyJobFailure({
      errorMessage: 'Request failed with status code 503',
      errorName: 'AxiosError',
      attemptsMade: 3,
      maxAttempts: 3,
    });
    assert.equal(v.classification, 'transient');
    assert.equal(v.deadLetter, true);
  });

  it('rate-limit errors are transient, never terminal (not mis-DLQ\'d at attempt 1)', () => {
    for (const input of [
      { errorName: 'OutboundChannelRateLimitedError', errorMessage: 'channel rate limited' },
      { errorName: 'Error', errorMessage: 'OpenAI 429 rate limit exceeded' },
    ]) {
      const v = classifyJobFailure({ ...input, attemptsMade: 1, maxAttempts: 3 });
      assert.equal(v.classification, 'transient', JSON.stringify(input));
      assert.equal(v.deadLetter, false, JSON.stringify(input));
    }
  });

  it('network errors are transient', () => {
    for (const msg of ['socket hang up', 'read ECONNRESET', 'connect ETIMEDOUT 1.2.3.4:443']) {
      const v = classifyJobFailure({ errorMessage: msg, attemptsMade: 1, maxAttempts: 3 });
      assert.equal(v.classification, 'transient', msg);
      assert.equal(v.deadLetter, false, msg);
    }
  });
});

describe('classifyJobFailure — terminal (record as terminal, DLQ at exhaustion)', () => {
  it('validation errors are terminal', () => {
    for (const name of ['ValidationError', 'ZodError', 'TypeError']) {
      const v = classifyJobFailure({ errorName: name, errorMessage: 'bad input', attemptsMade: 1, maxAttempts: 3 });
      assert.equal(v.classification, 'terminal', name);
      assert.equal(v.deadLetter, false, name); // not yet exhausted → no false-positive row
    }
  });

  it('a non-429 4xx is terminal; 429 stays transient', () => {
    const notFound = classifyJobFailure({ errorMessage: 'Request failed with status code 404', attemptsMade: 3, maxAttempts: 3 });
    assert.equal(notFound.classification, 'terminal');
    assert.equal(notFound.deadLetter, true);

    const rateLimited = classifyJobFailure({ errorMessage: 'Request failed with status code 429', attemptsMade: 1, maxAttempts: 3 });
    assert.equal(rateLimited.classification, 'transient');
  });
});

// ---------------------------------------------------------------------------
// P2-6 (RC-19) pins.
//
// P2-6's workstream (5) — "DLQ + exhaustion alerting, fix failureHandler misclassifying
// stall-killed jobs (C-88), route to Sentry" — was ALREADY DELIVERED by P1-2: C-88 is fixed above
// (the classifier keys on the stalled MESSAGE, never the attempt count), failureHandler always
// calls Sentry.captureException and raises a tenant-facing `ai_reply_undelivered` alert, and the
// dead_letter table + retention landed in migrations 072/076. The audit's description is stale.
//
// What P2-6 DOES add here is a new error class flowing into this classifier, and the interaction is
// load-bearing — see the DLQ-storm note below.
// ---------------------------------------------------------------------------

describe('P2-6 pin — ProviderUnavailableError vs. the DLQ', () => {
  /**
   * A provider outage is TRANSIENT: it must retry, never dead-letter at attempt 1. The name matches
   * no terminal marker, so it falls to the classifier's safe default — pinned here because the
   * default is what we are relying on, and a future marker-list edit could silently reclassify it.
   */
  it('is transient at attempt 1 — a provider blip must not dead-letter immediately', () => {
    const v = classifyJobFailure({
      errorName: 'ProviderUnavailableError',
      errorMessage: 'OpenAI chat call unavailable (breaker_open)',
      attemptsMade: 1,
      maxAttempts: 3,
    });
    assert.equal(v.classification, 'transient');
    assert.equal(v.deadLetter, false);
  });

  /**
   * THE DLQ-STORM INTERACTION, pinned as documentation.
   *
   * The breaker's fast-fail is FREE, so BullMQ's retry budget is denominated in attempts while the
   * breaker's cooldown is denominated in wall-clock. aiQueue retries at T+10s and T+30s
   * (attempts:3, exponential, delay:10_000). If OPENAI_BREAKER_COOLDOWN_MS spanned that window,
   * all three attempts would fast-fail without ever probing the provider, exhaust, and land here —
   * dead-lettering every in-flight reply over a blip that attempts 2 and 3 would have survived.
   *
   * Two things keep that from happening, and this test pins the consequence of both failing:
   *   1. OPENAI_BREAKER_COOLDOWN_MS defaults to 5s — below the 10s backoff base — so attempt 2
   *      genuinely re-probes.
   *   2. GRACEFUL_DEGRADE_MODE ships FIRST, so a ProviderUnavailableError becomes a holding reply
   *      and the job SUCCEEDS, never reaching BullMQ's retry budget at all.
   */
  it('at exhaustion it DOES dead-letter — which is why degrade must ship before the breaker', () => {
    const v = classifyJobFailure({
      errorName: 'ProviderUnavailableError',
      errorMessage: 'OpenAI chat call unavailable (breaker_open)',
      attemptsMade: 3,
      maxAttempts: 3,
    });
    assert.equal(v.deadLetter, true, 'exhausted ⇒ DLQ + a tenant-facing ai_reply_undelivered alert');
  });

  it('a turn-deadline fast-fail takes the same transient path', () => {
    const v = classifyJobFailure({
      errorName: 'ProviderUnavailableError',
      errorMessage: 'OpenAI chat call unavailable (turn_starved)',
      attemptsMade: 1,
      maxAttempts: 3,
    });
    assert.equal(v.classification, 'transient');
    assert.equal(v.deadLetter, false);
  });

  it('a stall-killed job stays terminal even when the message mentions the provider (C-88 holds)', () => {
    // Guards the ordering: the stalled check must win over any transient marker in the text.
    const v = classifyJobFailure({
      failedReason: STALLED_MESSAGE,
      errorName: 'UnrecoverableError',
      errorMessage: `${STALLED_MESSAGE} (during an OpenAI timeout)`,
      attemptsMade: 1,
      maxAttempts: 3,
    });
    assert.equal(v.classification, 'stalled');
    assert.equal(v.deadLetter, true);
  });
});

describe('classifyJobFailure — unknown errors default safe', () => {
  it('an opaque error retries then dead-letters at exhaustion', () => {
    const early = classifyJobFailure({ errorMessage: 'something odd happened', attemptsMade: 1, maxAttempts: 3 });
    assert.equal(early.classification, 'transient');
    assert.equal(early.deadLetter, false);

    const late = classifyJobFailure({ errorMessage: 'something odd happened', attemptsMade: 3, maxAttempts: 3 });
    assert.equal(late.deadLetter, true);
  });

  it('treats attemptsMade > maxAttempts (single-attempt queue) as exhausted', () => {
    const v = classifyJobFailure({ errorMessage: 'boom', attemptsMade: 1, maxAttempts: 1 });
    assert.equal(v.deadLetter, true);
  });
});
