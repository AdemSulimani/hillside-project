/**
 * P2-4 Part 2: retention sweep for `ai_decision_ledger`.
 *
 * P2-4's own Edge-cases line names "Retention/sampling + GDPR", and Part 2 is the last part — so
 * this is where it lands or it never does. The ledger writes a row per reply carrying a size-capped
 * preview derived from a 26–33K-char system prompt (i.e. customer conversation text, redacted but
 * still customer-derived), and had no prune path of any kind: `DELETE FROM ai_decision_ledger`
 * appeared nowhere in the codebase. For an EU-registered company that is a retention exposure, not
 * merely unbounded growth.
 *
 * Deliberately its OWN scheduler rather than a line in `deadLetterMonitor.tick`: that monitor is
 * gated behind DLQ_METRICS_ENABLED, and retention must not silently depend on whether someone
 * enabled DLQ metrics. Same shape, independent lifecycle.
 *
 * Prunes in bounded batches and re-ticks while a sweep is still deleting, so the first run over a
 * large backlog drains steadily instead of in one long transaction. Never throws — a retention blip
 * must not affect request handling.
 */
import { knobNumber } from '../config/knobs';
import { pruneLedger } from '../db/models/aiDecisionLedger';
import { prunePromptBlobs } from '../db/models/promptBlob';

// P2-7: read through the manifest. `LEDGER_RETENTION_DAYS`'s default was written here AND again as
// a literal inside validateEnv's boot log, so the two could disagree about what retention actually
// is — the drift class this item exists to remove.
const RETENTION_DAYS = knobNumber('LEDGER_RETENTION_DAYS');

const SWEEP_INTERVAL_MS = knobNumber('LEDGER_RETENTION_INTERVAL_MS');

/** Batch size per DELETE. Bounded so a backlog sweep never holds a long transaction. */
const BATCH_SIZE = 5_000;

/** Max batches per tick, so a huge backlog cannot monopolise the pool in one pass. */
const MAX_BATCHES_PER_TICK = 10;

export async function runLedgerRetentionSweep(): Promise<number> {
  let total = 0;
  try {
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const deleted = await pruneLedger(RETENTION_DAYS, BATCH_SIZE);
      total += deleted;
      // A short batch means the backlog is drained; wait for the next tick.
      if (deleted < BATCH_SIZE) break;
    }
    // P2-4 (F2): prune the content-addressed prompt blobs on the same retention window, keyed on
    // last_seen so a blob still referenced by fresh ledger rows survives.
    for (let i = 0; i < MAX_BATCHES_PER_TICK; i++) {
      const deleted = await prunePromptBlobs(RETENTION_DAYS, BATCH_SIZE);
      total += deleted;
      if (deleted < BATCH_SIZE) break;
    }
    if (total > 0) {
      console.info('[ledger-retention] pruned ai_decision_ledger + ai_prompt_blobs rows', {
        pruned: total,
        retentionDays: RETENTION_DAYS,
      });
    }
  } catch (err) {
    console.warn('[ledger-retention] sweep failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return total;
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startLedgerRetention(): void {
  if (sweepInterval) return;
  void runLedgerRetentionSweep();
  sweepInterval = setInterval(() => void runLedgerRetentionSweep(), SWEEP_INTERVAL_MS);
  console.info('[ledger-retention] Started', {
    retentionDays: RETENTION_DAYS,
    intervalMs: SWEEP_INTERVAL_MS,
  });
}

export function stopLedgerRetention(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
