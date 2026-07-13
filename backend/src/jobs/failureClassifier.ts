/**
 * P1-2 (RC-20/21/18): pure classification of a BullMQ job failure.
 *
 * `attachWorkerFailureHandler` runs this inside `worker.on('failed')` to decide whether a failure
 * should be dead-lettered now, later (at attempt exhaustion), or not at all. Keeping it pure — no
 * BullMQ / DB / env imports — makes the load-bearing rules unit-testable without a live queue.
 *
 * The critical case is C-88: a job SIGKILLed mid-run on deploy (SHUTDOWN_TIMEOUT_MS=25000 exceeds
 * Docker's 10s stop grace, server.ts) is terminally failed by BullMQ's stalled-checker as an
 * `UnrecoverableError` carrying the message below — but with `attemptsMade` still below `attempts`.
 * The legacy `attemptsMade >= attempts` guard therefore mislabels it "will retry" and drops it
 * silently. This classifier keys on the stalled message / error name, never on the attempt count,
 * for that path.
 */

export type JobFailureClassification = 'transient' | 'terminal' | 'stalled';

/** The exact literal BullMQ sets when a job exceeds `maxStalledCount` (moveStalledJobsToWait lua). */
export const STALLED_MESSAGE = 'job stalled more than allowable limit';

export interface ClassifyJobFailureInput {
  /** `job.failedReason` — BullMQ's recorded failure string. */
  failedReason?: string | null;
  /** `err.name`. */
  errorName?: string | null;
  /** `err.message`. */
  errorMessage?: string | null;
  /** `job.attemptsMade` (already includes the current attempt inside the failed listener). */
  attemptsMade: number;
  /** `job.opts.attempts ?? 1`. */
  maxAttempts: number;
}

export interface JobFailureVerdict {
  classification: JobFailureClassification;
  /** Whether this failure should be written to the dead_letter table right now. */
  deadLetter: boolean;
}

/**
 * Errors that are safe to keep retrying and must NOT be dead-lettered before exhaustion. Checked
 * before the terminal markers so a "503 rate limit" is never miscounted as a 4xx client error.
 */
const TRANSIENT_MARKERS = [
  'outboundchannelratelimitederror',
  'rate limit',
  'rate-limit',
  'ratelimit',
  '429',
  'timeout',
  'timed out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'enotfound',
  'eai_again',
  'socket hang up',
  'network',
  'temporarily unavailable',
  '500',
  '502',
  '503',
  '504',
];

/** Error names that will not succeed on retry — dead-letter once attempts are exhausted. */
const TERMINAL_ERROR_NAMES = new Set([
  'validationerror',
  'zoderror',
  'typeerror',
  'syntaxerror',
  'rangeerror',
  'referenceerror',
]);

/** Non-429 4xx client-error markers — a malformed request won't fix itself on retry. */
const TERMINAL_STATUS_MARKERS = ['400', '401', '403', '404', '409', '422'];

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

/**
 * Classify a job failure and decide whether it belongs in the DLQ now.
 *
 * Dead-letter timing:
 *  - `stalled` / `UnrecoverableError` → immediately (BullMQ will not retry these; C-88 fix).
 *  - everything else (`transient`, generic `terminal`) → only once attempts are exhausted. This
 *    records the classification for observability while guaranteeing no false-positive DLQ row for
 *    an error that later succeeds on a subsequent attempt — so no `completed`-listener retract is
 *    needed.
 */
export function classifyJobFailure(input: ClassifyJobFailureInput): JobFailureVerdict {
  const name = (input.errorName ?? '').trim().toLowerCase();
  const msg = (input.errorMessage ?? input.failedReason ?? '').toLowerCase();
  const exhausted = input.attemptsMade >= input.maxAttempts;

  // 1. Stalled (SIGKILL / lock-loss) — arrives AS an UnrecoverableError, so match the message first.
  if (msg.includes(STALLED_MESSAGE)) {
    return { classification: 'stalled', deadLetter: true };
  }

  // 2. Any other UnrecoverableError — BullMQ has already decided not to retry it.
  if (name === 'unrecoverableerror') {
    return { classification: 'terminal', deadLetter: true };
  }

  // 3. Transient markers win over terminal ones (a "503" or "429" is retryable, not a 4xx).
  if (includesAny(name, TRANSIENT_MARKERS) || includesAny(msg, TRANSIENT_MARKERS)) {
    return { classification: 'transient', deadLetter: exhausted };
  }

  // 4. Deterministic terminal errors (validation / non-429 4xx) — record as terminal, DLQ at exhaustion.
  if (TERMINAL_ERROR_NAMES.has(name) || includesAny(msg, TERMINAL_STATUS_MARKERS)) {
    return { classification: 'terminal', deadLetter: exhausted };
  }

  // 5. Unknown → treat as transient; retry, and dead-letter only if it never recovers.
  return { classification: 'transient', deadLetter: exhausted };
}
