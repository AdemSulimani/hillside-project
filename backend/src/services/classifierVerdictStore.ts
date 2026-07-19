/**
 * P1-3 (RC-08): per-message classifier-verdict persistence.
 *
 * The intent detectors run BEFORE the P1-1 staging boundary, so a BullMQ retry (P0-4's
 * deliberate pre-send re-throw, a crash, a lock/fairness reschedule that re-enters the job)
 * re-calls every stochastic detector — a score that was 0.86 on the first attempt can come
 * back 0.83 and flip the outcome class. Hysteresis narrows the flip zone but its band edges
 * are themselves hard boundaries; the only real fix is to make the verdict a function of the
 * (conversation, logical inbound) pair rather than of the attempt.
 *
 * `getOrComputeClassifierVerdict` caches each detector's JSON verdict in Redis keyed by
 * `ai_clf:{conversationId}:{inboundExternalId}:{detector}` with a TTL comfortably beyond the
 * BullMQ retry horizon. Fail-open on every Redis error (compute normally, never block the
 * reply), and the cached value is only ever a detector's own returned object — no customer
 * text is stored (PII stays in the canonical `messages` store, P1-6).
 *
 * Gated by `CLASSIFIER_VERDICT_PERSISTENCE` (default OFF → every call computes, byte-for-byte
 * legacy). Uses the logical inbound external id (identical across retries, re-pointed by
 * burst-merge) — the same keying discipline as `deriveReplyIdempotencyKey` (P1-1).
 */
import { redisConnection } from '../jobs/redisConnection';
import { knobBool } from '../config/knobs';

/**
 * P3-6: routed through the knob manifest. It was a bare `process.env` read, which meant
 * `config:check`, `.env.example` drift detection and the fleet config fingerprint were all blind
 * to it — and this flag decides whether a detector's verdict is stable across a BullMQ retry, so
 * two workers disagreeing about it is precisely the RC-08 outcome-flip the store exists to
 * prevent. It is also a real cost lever: cached verdicts remove repeat classifier calls on retry.
 */
export const CLASSIFIER_VERDICT_PERSISTENCE = knobBool('CLASSIFIER_VERDICT_PERSISTENCE');

/** TTL for a persisted verdict — 6h, well beyond any BullMQ retry/backoff horizon. */
const VERDICT_TTL_SECONDS = 6 * 3600;

export function classifierVerdictKey(
  conversationId: string,
  inboundExternalId: string,
  detector: string,
): string {
  return `ai_clf:${conversationId}:${inboundExternalId}:${detector}`;
}

/**
 * Return the persisted verdict for this (conversation, inbound, detector) when present,
 * otherwise compute it and persist best-effort. The `compute` result must be JSON-serializable
 * (every detector returns a plain object). Flag off → straight pass-through to `compute`.
 */
/** Minimal Redis surface used here — injectable so the store is unit-testable with a fake. */
export interface VerdictRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ex: 'EX', ttl: number): Promise<unknown>;
}

export async function getOrComputeClassifierVerdict<T>(args: {
  conversationId: string;
  inboundExternalId: string;
  detector: string;
  compute: () => Promise<T>;
  enabled?: boolean;
  redis?: VerdictRedisLike;
}): Promise<T> {
  const enabled = args.enabled ?? CLASSIFIER_VERDICT_PERSISTENCE;
  if (!enabled) return args.compute();
  const redis: VerdictRedisLike = args.redis ?? redisConnection;

  const key = classifierVerdictKey(args.conversationId, args.inboundExternalId, args.detector);
  const cached = await redis.get(key).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached) as T;
    } catch {
      // Corrupted entry — fall through to a fresh compute (which overwrites it).
    }
  }

  const verdict = await args.compute();
  await redis
    .set(key, JSON.stringify(verdict), 'EX', VERDICT_TTL_SECONDS)
    .catch(() => undefined);
  return verdict;
}
