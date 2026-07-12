/**
 * P0-5 (RC-14) part 4 — AI-pause invariant monitor (observational).
 *
 * Invariant: no conversation may remain AI-paused with an inbound newer than `ai_paused_at`
 * and no open sensitive alert. A conversation violating it is a permanent-silence dead-end
 * that auto-resume (parts 2/3) should have cleared — the exact RC-14 failure mode.
 *
 * This job only LOGS the violation count (plus a bounded id sample) so the failure becomes
 * visible; it performs NO writes and never resumes anything. It is gated on AI_AUTO_RESUME:
 * when the flag is off, auto-resume is inactive and "stuck paused" is the intended legacy
 * behaviour, so the monitor is a no-op rather than noise.
 */
import { findPauseInvariantViolations } from '../db/models/conversation';
import { defaultQueue } from './queues';

const AI_AUTO_RESUME =
  (process.env.AI_AUTO_RESUME ?? 'false').trim().toLowerCase() === 'true';

/** Cron for the invariant monitor (default hourly). */
export const PAUSE_INVARIANT_MONITOR_CRON =
  process.env.AI_PAUSE_INVARIANT_MONITOR_CRON ?? '0 * * * *';

/** How many violating ids to include in the log sample (the full count is always logged). */
const VIOLATION_SAMPLE_SIZE = 50;

export async function runPauseInvariantMonitor(): Promise<void> {
  if (!AI_AUTO_RESUME) return;

  const violations = await findPauseInvariantViolations();
  if (violations.length === 0) {
    console.info('[ai.pauseInvariant] no violations');
    return;
  }

  console.warn(
    '[ai.pauseInvariant] conversations left AI-paused past a newer inbound with no open sensitive alert',
    {
      count: violations.length,
      sample: violations
        .slice(0, VIOLATION_SAMPLE_SIZE)
        .map((v) => ({ id: v.id, tenantId: v.tenant_id, reason: v.ai_paused_reason })),
    },
  );
}

export async function initPauseInvariantMonitorScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    'pauseInvariantMonitor',
    { pattern: PAUSE_INVARIANT_MONITOR_CRON },
    {
      name: 'pauseInvariantMonitor',
      data: {} as Record<string, never>,
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    },
  );

  console.info('[jobs] Pause invariant monitor scheduler registered', {
    cron: PAUSE_INVARIANT_MONITOR_CRON,
  });
}
