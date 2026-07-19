/**
 * P3-6 — COGS anomaly dispatch: the IO half of `services/costAnomaly.ts`.
 *
 * CHANNEL: platform ops (Sentry + ALERT_WEBHOOK_URL), mirroring `services/deadLetterMonitor.ts`.
 *
 * DELIBERATELY NOT `ai_alerts`, for three reasons that are worth stating because the table is
 * otherwise the obvious home for anything called "alert":
 *   1. `ai_alerts` is MERCHANT-FACING — it renders in the tenant's AI Alerts inbox. "Your
 *      conversations cost us more than they earn" is a margin disclosure, not a notification the
 *      merchant can act on.
 *   2. `ai_alerts` rows participate in pause/resume semantics (`fail_closed`, the sensitive-reason
 *      sets). A cost signal must never acquire a path to stopping replies.
 *   3. The condition belongs to no tenant's conversation — it is a platform margin fact. The same
 *      reasoning already recorded for breaker transitions in `openaiClient`.
 *
 * Never throws: a monitoring call must not affect request handling.
 */
import axios from 'axios';
import * as Sentry from '@sentry/node';
import { knobBool, knobNumber } from '../config/knobs';
import pool from '../db/pool';
import {
  detectCostAnomalies,
  rearmedKinds,
  type CostAnomaly,
  type CostAnomalyKind,
  type CostAnomalyThresholds,
  type TenantCostFacts,
} from './costAnomaly';
import {
  getCostOutliers,
  getModelsByRole,
  getTenantCostPeriodStats,
} from './platformCostService';
import { calculateProgressiveFee } from './aiUseCaseService';
import { logger } from '../utils/logger';

/**
 * Which (tenant, kind) pairs are currently firing.
 *
 * In-process, matching `deadLetterMonitor`'s posture: the sweep is a fleet-singleton BullMQ job,
 * so exactly one process holds this state at a time, and the cost of a restart is one duplicate
 * alert rather than a missed one. A Redis-backed set would survive restarts but adds a failure
 * mode (Redis down ⇒ alert storm or silence) to a component whose entire job is to be quieter
 * than the thing it watches.
 */
const tripped = new Map<string, Set<CostAnomalyKind>>();

function trippedFor(tenantId: string): Set<CostAnomalyKind> {
  let s = tripped.get(tenantId);
  if (!s) {
    s = new Set();
    tripped.set(tenantId, s);
  }
  return s;
}

function readThresholds(): CostAnomalyThresholds {
  return {
    marginRatio: knobNumber('AI_COST_MARGIN_ALERT_RATIO'),
    conversationUsd: knobNumber('AI_COST_CONVERSATION_ALERT_USD'),
    turnCalls: knobNumber('AI_COST_TURN_CALL_ALERT'),
    modelDrift: knobBool('AI_COST_MODEL_DRIFT_ALERT'),
  };
}

/** Current UTC month bounds + its 'YYYY-MM' key — the period every cost alert is scoped to. */
export function currentMonthWindow(now: Date): { from: Date; to: Date; period: string } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return { from, to, period };
}

/**
 * Billed revenue for a tenant in a period: order commission + use-case fees.
 *
 * ⚠️ USE-CASE FEES MUST BE COMPUTED, NOT SUMMED. `ai_use_cases.fee_amount` is NULL until the
 * month-end snapshot job stamps it (CLAUDE.md §11: "Use-case fee amounts are not stamped at
 * creation... Queries on fee_amount before month-end will see nulls"). Summing the column for the
 * CURRENT month — which is exactly the window this alerter runs on — would yield 0 for every
 * tenant, inflating every COGS/revenue ratio and firing a margin-inversion alert on healthy
 * tenants for the first ~30 days of every month. So the fee is derived from the completed-case
 * COUNT via the same progressive-tier function the credits dashboard projects with.
 *
 * Currency note: commission and fees are EUR; COGS is USD. The ratio is therefore approximate
 * (~8% off at recent rates) and is used only to trip a coarse threshold, never to bill.
 */
async function billedRevenueForPeriod(tenantId: string, from: Date, to: Date): Promise<number> {
  const { rows } = await pool.query<{ commission: string; use_case_count: string }>(
    `SELECT
       COALESCE((SELECT SUM(commission_amount) FROM orders
                  WHERE tenant_id = $1 AND is_commissionable = true
                    AND created_at >= $2 AND created_at < $3), 0)::text AS commission,
       (SELECT COUNT(*) FROM ai_use_cases
         WHERE tenant_id = $1 AND status = 'completed'
           AND resolved_at >= $2 AND resolved_at < $3)::text AS use_case_count`,
    [tenantId, from, to],
  );
  const commission = parseFloat(rows[0]?.commission ?? '0');
  const useCaseCount = parseInt(rows[0]?.use_case_count ?? '0', 10);
  return commission + calculateProgressiveFee(useCaseCount);
}

async function dispatch(anomaly: CostAnomaly): Promise<void> {
  Sentry.captureMessage(`ai cost anomaly: ${anomaly.kind}`, {
    level: 'warning',
    tags: { component: 'ai_cost', anomaly: anomaly.kind, tenant: anomaly.tenantId },
    extra: { ...anomaly.detail, measure: anomaly.measure, threshold: anomaly.threshold },
  });

  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;

  const detail = Object.entries(anomaly.detail)
    .map(([k, v]) => `${k}: \`${v}\``)
    .join('\n');
  const text = [
    `💸 *AI cost anomaly — ${anomaly.kind}*`,
    `Tenant \`${anomaly.tenantId}\`, measure \`${anomaly.measure}\` (threshold \`${anomaly.threshold}\`).`,
    detail,
  ].join('\n');

  try {
    await axios.post(
      url,
      { text },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8_000, validateStatus: () => true },
    );
  } catch (err) {
    logger.warn('[cost-anomaly] webhook post failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface CostAnomalyScanResult {
  scanned: number;
  fired: number;
  rearmed: number;
  skipped: boolean;
}

/**
 * Scan every tenant that produced AI traffic this month and dispatch newly-crossed anomalies.
 *
 * Runs immediately after the rollup sweep in the same job, so it reads a settled snapshot.
 */
export async function runCostAnomalyScan(
  opts: { now?: Date } = {},
): Promise<CostAnomalyScanResult> {
  const result: CostAnomalyScanResult = { scanned: 0, fired: 0, rearmed: 0, skipped: true };
  if (!knobBool('AI_COST_ANOMALY_ALERTS')) return result;

  const thresholds = readThresholds();
  const rearmFactor = knobNumber('AI_COST_ALERT_REARM_FACTOR');
  const { from, to, period } = currentMonthWindow(opts.now ?? new Date());

  try {
    // Only tenants with traffic in the window — scanning idle tenants is pure cost for a
    // guaranteed-zero answer.
    const { rows: tenants } = await pool.query<{ tenant_id: string }>(
      `SELECT DISTINCT tenant_id FROM ai_decision_ledger
        WHERE created_at >= $1 AND created_at < $2`,
      [from, to],
    );

    let fired = 0;
    let rearmed = 0;
    for (const { tenant_id: tenantId } of tenants) {
      try {
        const [stats, outliers, modelsByRole, revenue] = await Promise.all([
          getTenantCostPeriodStats(tenantId, from, to, true),
          getCostOutliers(tenantId, from, to),
          getModelsByRole(tenantId, from, to),
          billedRevenueForPeriod(tenantId, from, to),
        ]);

        const facts: TenantCostFacts = {
          tenantId,
          period,
          usdCost: stats.usd_cost,
          revenue,
          unpricedCalls: stats.unpriced_calls,
          modelsByRole,
          worstConversation: outliers.worstConversation,
          worstTurn: outliers.worstTurn,
        };

        const state = trippedFor(tenantId);
        for (const kind of rearmedKinds(facts, thresholds, state, rearmFactor)) {
          state.delete(kind);
          rearmed += 1;
        }
        const anomalies = detectCostAnomalies(facts, thresholds, state, rearmFactor);
        for (const anomaly of anomalies) {
          state.add(anomaly.kind);
          await dispatch(anomaly);
          fired += 1;
        }
      } catch (err) {
        // One tenant failing must not abandon the scan.
        logger.warn('[cost-anomaly] tenant scan failed', {
          tenantId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (fired > 0 || rearmed > 0) {
      logger.info('[cost-anomaly] scan complete', { scanned: tenants.length, fired, rearmed, period });
    }
    return { scanned: tenants.length, fired, rearmed, skipped: false };
  } catch (err) {
    logger.warn('[cost-anomaly] scan failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return { ...result, skipped: false };
  }
}

/** Test seam: clear the in-process breaker state. */
export function resetCostAnomalyState(): void {
  tripped.clear();
}
