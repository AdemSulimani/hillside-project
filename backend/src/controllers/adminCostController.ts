/**
 * P3-6 — the platform admin's COGS read surface (OBS-2 / C-108).
 *
 * ADMIN-ONLY, BY DESIGN. Per-tenant serving cost is Hillside's own margin data on a commission
 * product; the merchant-facing `/api/credits` surface stays revenue-only. Telling a merchant "we
 * spent $14 of model tokens serving you and billed you €31" hands them the opening position in a
 * fee negotiation, and `usage.calls[]` additionally reveals which models route which decisions.
 *
 * A SEPARATE CONTROLLER from `adminCommissionController` deliberately: this one is read-only over
 * telemetry, while that one holds the billing WRITE paths (mark-billed, mark-paid, void). Keeping
 * them apart means a cost route can never reach a billing mutation.
 */
import type { Request, Response } from 'express';
import { sendError, sendSuccess } from '../utils/response';
import { findTenantById } from '../db/models/tenant';
import {
  getFleetCostSummary,
  getTenantCostPeriodStats,
  getTenantCostFromRollup,
} from '../services/platformCostService';
import { isDecisionLedgerEnabled } from '../jobs/aiDecisionLedgerWriter';
import type { AdminPeriodQueryRequired } from '../validators/admin';

/** Same conversion `adminCommissionController` uses: an inclusive end date to a half-open range. */
function periodToUtcRange(periodStart: string, periodEnd: string): { start: Date; endExclusive: Date } {
  const start = new Date(`${periodStart}T00:00:00.000Z`);
  const lastDay = new Date(`${periodEnd}T00:00:00.000Z`);
  return { start, endExclusive: new Date(lastDay.getTime() + 86400000) };
}

export async function businessCostStats(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const q = (req.validated?.query ?? req.query) as unknown as AdminPeriodQueryRequired;
    // Read `source` off the RAW query: the validated object comes from a Zod schema that strips
    // unknown keys, so `req.validated.query.source` would always be undefined and the rollup path
    // would be silently unreachable.
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const { start, endExclusive } = periodToUtcRange(q.period_start, q.period_end);
    // `source=rollup` reads the durable table, which is the ONLY path that can answer a window
    // older than LEDGER_RETENTION_DAYS — the ledger rows behind it are gone by then.
    const stats =
      source === 'rollup'
        ? await getTenantCostFromRollup(
            tenantId,
            q.period_start,
            q.period_end,
            isDecisionLedgerEnabled(),
          )
        : await getTenantCostPeriodStats(tenantId, start, endExclusive, isDecisionLedgerEnabled());

    sendSuccess(res, stats, 'Cost stats retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load cost stats', 500, err);
  }
}

export async function dashboardCostSummary(req: Request, res: Response): Promise<void> {
  try {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const tenants = await getFleetCostSummary(start, endExclusive);

    sendSuccess(
      res,
      {
        period: `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`,
        total_usd_cost: Math.round(tenants.reduce((s, t) => s + t.usd_cost, 0) * 1e6) / 1e6,
        total_turns: tenants.reduce((s, t) => s + t.turns, 0),
        total_calls: tenants.reduce((s, t) => s + t.calls, 0),
        tenants,
        // A hint, not a fact: the ledger is written by WORKER processes while this endpoint is
        // served by the API, so in a split topology (P3-2) the two can legitimately disagree.
        ledger_enabled_on_this_process: isDecisionLedgerEnabled(),
      },
      'Fleet cost summary retrieved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to load fleet cost summary', 500, err);
  }
}
