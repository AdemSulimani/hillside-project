/**
 * P3-2 Step 7 — the two maintenance sweeps that must run ONCE per tick fleet-wide.
 *
 * `redisMemoryMonitor`, `deadLetterMonitor` and `ledgerRetention` were all bare `setInterval`s in
 * `server.ts`'s `listen` callback. That is fine for one process and wrong for a fleet: unlike the
 * nine BullMQ schedulers (which `upsertJobScheduler` dedupes by key), an interval runs once per
 * replica. Two of the three do real work when they fire —
 *
 *   - `ledgerRetention` issues bounded `DELETE`s against `ai_decision_ledger` and `ai_prompt_blobs`;
 *   - `deadLetterMonitor` prunes replayed `dead_letter` rows and can emit a Sentry burst alert;
 *
 * so N replicas means N concurrent delete sweeps competing for the same rows and N copies of the
 * same alert. Moving them onto the `default` queue makes them fleet-singletons for free, using
 * machinery that is already proven here (`outboxRelay.initOutboxRelayScheduler` is the template).
 *
 * `redisMemoryMonitor` deliberately stays an in-process interval on the API. It only READS `INFO
 * memory` and logs, so duplication is harmless; and Redis exhaustion is precisely the condition
 * under which a Redis-scheduled job would stop firing — a monitor that goes silent exactly when the
 * thing it monitors breaks is worse than one that runs twice.
 */
import { defaultQueue } from './queues';
import { knobNumber } from '../config/knobs';

export const LEDGER_RETENTION_JOB = 'ledgerRetentionSweep';
export const DLQ_METRICS_JOB = 'deadLetterMetrics';
export const PROMPT_REGISTRY_JOB = 'promptRegistryReconcile';

const DLQ_METRICS_INTERVAL_MS = (() => {
  const raw = process.env.DLQ_METRICS_INTERVAL_MS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

/**
 * Registered unconditionally, matching the reasoning already recorded in `server.ts`: rows written
 * during a flag-on window carry a GDPR retention obligation that does not end when recording stops,
 * so the sweep must not be gated on `AI_DECISION_LEDGER_ENABLED`. On an empty table it is one cheap
 * indexed DELETE per tick.
 */
export async function initLedgerRetentionScheduler(): Promise<void> {
  const everyMs = knobNumber('LEDGER_RETENTION_INTERVAL_MS');
  await defaultQueue.upsertJobScheduler(
    LEDGER_RETENTION_JOB,
    { every: everyMs },
    {
      name: LEDGER_RETENTION_JOB,
      data: {} as Record<string, never>,
      opts: { removeOnComplete: 10, removeOnFail: 50 },
    },
  );
  console.info('[jobs] Ledger retention scheduler registered', { everyMs });
}

/** Gated on the same `DLQ_METRICS_ENABLED` flag the in-process monitor used. */
export async function initDeadLetterMetricsScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    DLQ_METRICS_JOB,
    { every: DLQ_METRICS_INTERVAL_MS },
    {
      name: DLQ_METRICS_JOB,
      data: {} as Record<string, never>,
      opts: { removeOnComplete: 10, removeOnFail: 50 },
    },
  );
  console.info('[jobs] Dead-letter metrics scheduler registered', {
    everyMs: DLQ_METRICS_INTERVAL_MS,
  });
}

/**
 * P3-5: the prompt-registry reconcile sweep. Registered unconditionally, for the same reason as
 * the ledger sweep above and one more: once `PROMPT_SELF_HEAL_OFF_HOT_PATH` is on, this sweep is
 * the ONLY thing that repairs a tenant whose locked blocks drifted. A scheduler that only exists
 * while a second, unrelated flag is on would make that repair silently conditional. The sweep
 * itself returns immediately when `PROMPT_BLOCK_REGISTRY` is off, so an unconfigured fleet pays
 * one no-op job per tick.
 */
export async function initPromptRegistryScheduler(): Promise<void> {
  const everyMs = knobNumber('PROMPT_REGISTRY_RECONCILE_INTERVAL_MS');
  await defaultQueue.upsertJobScheduler(
    PROMPT_REGISTRY_JOB,
    { every: everyMs },
    {
      name: PROMPT_REGISTRY_JOB,
      data: {} as Record<string, never>,
      opts: { removeOnComplete: 10, removeOnFail: 50 },
    },
  );
  console.info('[jobs] Prompt registry reconcile scheduler registered', { everyMs });
}

/**
 * Remove a scheduler that a previous deploy registered. Needed when the flag is turned OFF: the
 * scheduler record lives in Redis, so without this it would keep firing forever after the code
 * stopped wanting it. `reconcileProductEmbeddings` set the precedent for cleaning up a stale key.
 */
export async function removeDeadLetterMetricsScheduler(): Promise<void> {
  await defaultQueue.removeJobScheduler(DLQ_METRICS_JOB).catch(() => undefined);
}
