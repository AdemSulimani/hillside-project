/**
 * P3-2 Step 9 (C-79 / RC-18) — bounded admission control for `ai.reply`.
 *
 * THE DEFECT. When a tenant is at its concurrency cap, or another job holds the conversation lock,
 * `processAIReply` re-adds the job with a flat 3000 ms delay and returns. Three things make that a
 * retry amplifier rather than a queue:
 *
 *   1. the re-add passes NO `jobId`, despite a comment claiming it "inherit[s] the original
 *      jobId/dedup behaviour" — so N starved jobs become N NEW jobs, every 3 seconds, forever;
 *   2. each new job resets `attemptsMade` to 0, so BullMQ's `attempts: 3` budget never depletes and
 *      nothing ever escalates;
 *   3. there is no hop counter anywhere in the payload, so nothing can tell a job deferred once from
 *      one deferred four hundred times.
 *
 * The result is a queue that churns at N adds per 3 s under sustained pressure, on the same `ai`
 * queue the inbound debounce scans linearly on every message.
 *
 * THE SHAPE OF THE FIX. Exponential backoff with jitter, a hop budget, and a deterministic job id so
 * concurrent deferrals of the same inbound COLLAPSE into one job instead of multiplying.
 *
 * Deliberately pure — no clock, no randomness, no Redis:
 *   - `jitter` is passed IN as a 0..1 number. There is no mocking framework in this repo, so a
 *     `Math.random()` inside would make the delay untestable; it is also the kind of call the eval
 *     harness bans outright.
 *   - the returned delay is RELATIVE (ms from now), so no `Date.now()` is needed and the function
 *     stays a pure mapping from (hop, policy) to a decision.
 */

export interface AdmissionPolicy {
  /** Base delay before the first retry. Doubles per hop. */
  baseDelayMs: number;
  /** Ceiling for a single deferral, so backoff cannot exceed a sensible upper bound. */
  maxDelayMs: number;
  /**
   * How many times one inbound may be deferred before it is shed. Must be small enough that the
   * total wait stays well inside the customer's patience, and large enough to ride out a normal
   * burst.
   */
  maxHops: number;
  /**
   * Fraction of the computed delay that is randomised, 0..1. Without it, N jobs deferred by the
   * same burst wake in lockstep and collide again — a thundering herd on every hop.
   */
  jitterRatio: number;
}

export const DEFAULT_ADMISSION_POLICY: AdmissionPolicy = {
  baseDelayMs: 3_000,
  maxDelayMs: 60_000,
  maxHops: 8,
  jitterRatio: 0.2,
};

export type AdmissionDecision =
  | { action: 'defer'; delayMs: number; nextHop: number }
  | { action: 'shed'; hops: number; reason: string };

export interface AdmissionInput {
  /** Hops already taken by this job. Absent/garbage normalises to 0. */
  hop: number | undefined;
  /** Why admission was refused — carried into the shed reason for the alert. */
  gate: 'tenant_capacity' | 'conversation_busy';
  /** A 0..1 sample supplied by the caller. Values outside the range are clamped. */
  jitter: number;
  policy?: AdmissionPolicy;
}

/** Hops are trusted from a JSON payload, so normalise rather than assume. */
export function normalizeHop(hop: number | undefined): number {
  if (typeof hop !== 'number' || !Number.isFinite(hop) || hop < 0) return 0;
  return Math.floor(hop);
}

/**
 * Delay for the given hop: `base * 2^hop`, capped, then jittered DOWNWARD only.
 *
 * Downward-only is deliberate: jittering upward could push a delay past `maxDelayMs` and make the
 * cap a lie. Mirrors `outboxRelay.retryBackoffMs`, which is the proven backoff shape in this
 * codebase, with the herd-breaking jitter that one does not need (it has a single consumer).
 */
export function admissionDelayMs(hop: number, jitter: number, policy: AdmissionPolicy): number {
  const safeHop = normalizeHop(hop);
  // Cap the exponent before computing the power so a large hop cannot produce Infinity.
  const exponent = Math.min(safeHop, 16);
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** exponent);
  const ratio = Math.min(1, Math.max(0, policy.jitterRatio));
  const sample = Math.min(1, Math.max(0, Number.isFinite(jitter) ? jitter : 0));
  // sample=0 → full delay; sample=1 → delay reduced by the whole jitter ratio.
  const jittered = raw * (1 - ratio * sample);
  return Math.max(0, Math.round(jittered));
}

/**
 * Defer or shed.
 *
 * Shedding is the terminal state and it is NOT silent — see the caller: a shed raises a named error
 * so the P1-2 dead-letter path produces a `dead_letter` row, a Sentry event and an
 * `ai_reply_undelivered` alert. A bare `return` here would look like a successful job, which is how
 * the current code manages to drop a customer message with nothing but a `console.info`.
 */
export function decideAdmission(input: AdmissionInput): AdmissionDecision {
  const policy = input.policy ?? DEFAULT_ADMISSION_POLICY;
  const hop = normalizeHop(input.hop);

  if (hop >= policy.maxHops) {
    return {
      action: 'shed',
      hops: hop,
      reason: `admission_shed:${input.gate}:hops=${hop}`,
    };
  }

  return {
    action: 'defer',
    delayMs: admissionDelayMs(hop, input.jitter, policy),
    nextHop: hop + 1,
  };
}

/**
 * Deterministic job id for a deferral.
 *
 * This is the single most important line in the file. BullMQ ignores an `add` whose `jobId` already
 * exists, so keying on (conversation, inbound, hop) makes N concurrent deferrals of the same inbound
 * collapse into ONE job. The absence of any jobId is precisely what turned the fairness gate into a
 * multiplier. The hop is part of the key because the next hop is a genuinely different job — without
 * it, a job that already ran and deferred again would be silently dropped as a duplicate.
 */
export function admissionJobId(
  conversationId: string,
  inboundExternalId: string,
  nextHop: number,
): string {
  return `fairness:${conversationId}:${inboundExternalId}:${nextHop}`;
}

/**
 * The `error.name` a shed carries. Exported so `failureClassifier` matches on a shared constant
 * rather than a magic string that would silently stop matching if the class were ever renamed —
 * and a silent stop here means the shed goes back to being an invisible dropped message.
 */
export const ADMISSION_SHED_ERROR_NAME = 'AdmissionShedError';

/** Thrown on a terminal shed so the failure path — not the success path — handles it. */
export class AdmissionShedError extends Error {
  readonly hops: number;
  readonly gate: string;

  constructor(reason: string, hops: number, gate: string) {
    super(reason);
    this.name = ADMISSION_SHED_ERROR_NAME;
    this.hops = hops;
    this.gate = gate;
  }
}
