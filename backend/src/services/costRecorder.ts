/**
 * P3-6 — background-job COGS capture.
 *
 * THE GAP THIS CLOSES. `openaiCallTracker` records every OpenAI call made inside a tracking
 * context, and `processAIReply` enters one per reply. Nothing else does — so product imports,
 * catalog image fingerprinting and the admin AI test burn tokens that appear in no cost figure
 * anywhere. That matters more than the call count suggests: a single product import runs an
 * 8000-char extraction at 4096 max_tokens, and the 5k-product tenant on the roadmap will run
 * thousands of them in a burst that currently shows up as a mysterious OpenAI invoice line.
 *
 * WHY NOT THE LEDGER. `ai_decision_ledger` is reply-scoped — `decision_kind`, `reply_slot` and
 * `idempotency_key` are NOT NULL and describe a conversation turn. Forcing an import into that
 * shape would corrupt the per-turn grain every aggregate in `costAggregation` depends on. Job
 * spend goes straight to `ai_cost_daily` with `source='job'`, which keeps it visible in the same
 * admin panel and separable from conversation COGS with a WHERE clause.
 *
 * Best-effort throughout: a cost write must never fail the job that earned the cost.
 */
import { addJobCost } from '../db/models/aiCostDaily';
import { knobBool } from '../config/knobs';
import {
  getTrackedOpenAICalls,
  runWithOpenAICallTracking,
  type TrackedOpenAICall,
} from './openaiCallTracker';
import { foldTurnCosts } from './costAggregation';
import { utcDayKey } from './costRollup';
import { logger } from '../utils/logger';
import type { LedgerUsage } from '../db/models/aiDecisionLedger';

/**
 * Run `fn` inside a tracking context and persist whatever OpenAI spend it produced.
 *
 * Nests safely: if a tracking context is ALREADY active (e.g. an image fingerprint generated
 * during a reply turn), this does not open a second one — it just runs `fn`, leaving the calls to
 * be recorded by the enclosing turn's ledger row. Double-recording the same call as both reply
 * and job spend would inflate total COGS, and the reply is the truer attribution.
 */
export async function withJobCostTracking<T>(
  args: { tenantId: string; job: string },
  fn: () => Promise<T>,
): Promise<T> {
  if (!knobBool('AI_COST_JOB_CAPTURE')) return fn();
  if (getTrackedOpenAICalls() !== null) return fn();

  return runWithOpenAICallTracking(async () => {
    try {
      return await fn();
    } finally {
      const calls = getTrackedOpenAICalls() ?? [];
      if (calls.length > 0) {
        // Fire-and-forget: the job's own result is already decided by this point, and a cost
        // write must not turn a successful import into a failed one.
        void recordJobCalls(args.tenantId, args.job, calls).catch(() => undefined);
      }
    }
  });
}

/** Fold a job's tracked calls and upsert them into today's `ai_cost_daily` job rows. */
export async function recordJobCalls(
  tenantId: string,
  job: string,
  calls: TrackedOpenAICall[],
  now: Date = new Date(),
): Promise<void> {
  try {
    // Reuse the same fold the reply path uses so job and reply COGS are computed identically —
    // one arithmetic, two sources. `conversation_id: null` means the fold's distinct-conversation
    // counter stays at zero, which is correct: a job has no conversation. The main-completion
    // fields are null because a job has no "main" call; only `calls` is meaningful here.
    const usage: LedgerUsage = {
      prompt_tokens: null,
      completion_tokens: null,
      total_tokens: null,
      usd_cost: null,
      calls,
    };
    const rows = foldTurnCosts([{ conversation_id: null, usage }], 'job');
    const day = utcDayKey(now);
    for (const row of rows) {
      await addJobCost({
        tenantId,
        day,
        role: row.role,
        model: row.model,
        kind: row.kind,
        calls: row.calls,
        pricedCalls: row.priced_calls,
        promptTokens: row.prompt_tokens,
        cachedTokens: row.cached_tokens,
        completionTokens: row.completion_tokens,
        usdCost: row.usd_cost,
      });
    }
    logger.info('[cost] job usage', {
      tenantId,
      job,
      calls: calls.length,
      usd: rows.reduce((s, r) => s + r.usd_cost, 0),
    });
  } catch (err) {
    logger.warn('[cost] job usage record failed', {
      tenantId,
      job,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
