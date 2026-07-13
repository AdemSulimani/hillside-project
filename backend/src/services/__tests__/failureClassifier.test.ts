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
