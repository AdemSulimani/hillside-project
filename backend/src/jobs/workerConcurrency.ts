/**
 * P3-2 Step 5 — worker concurrency parsing, extracted from the ad-hoc `envInt` in `workers.ts`.
 *
 * Deliberately NOT in `config/knobs.ts`, and the reason matters. `shouldFingerprint` defaults to
 * true for every declared knob, and these five are *supposed* to differ between an API process and
 * a worker process (an API-only replica runs no workers at all). Declaring them would make
 * `count(DISTINCT hash) > 1` permanently true and destroy the fleet-drift signal that exists to
 * catch real DECISION-knob skew. They stay documented in `.env.example` only, which is safe because
 * the drift check is one-directional.
 *
 * Pure module: no BullMQ, no Redis, no `process.env` capture at import — the env bag is passed in,
 * matching the house idiom that keeps job logic testable without opening a handle.
 */

export const WORKER_CONCURRENCY_DEFAULTS = {
  WEBHOOK_WORKER_CONCURRENCY: 10,
  AI_WORKER_CONCURRENCY: 5,
  NOTIFICATIONS_WORKER_CONCURRENCY: 3,
  FINETUNING_WORKER_CONCURRENCY: 1,
  DEFAULT_WORKER_CONCURRENCY: 3,
} as const;

export type WorkerConcurrencyKey = keyof typeof WORKER_CONCURRENCY_DEFAULTS;

/**
 * Preserves the previous `envInt` semantics byte-for-byte: absent, empty, unparseable, zero and
 * negative all fall back to the default. Notably `'0'` does NOT mean "disable this worker" — it
 * never did, and changing that here would silently stop a queue on a host that set it expecting
 * exactly that. Disabling a whole class of work is `PROCESS_ROLE`'s job, not a concurrency of zero.
 */
export function resolveWorkerConcurrency(
  key: WorkerConcurrencyKey,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const fallback = WORKER_CONCURRENCY_DEFAULTS[key];
  const raw = env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
