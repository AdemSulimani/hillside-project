import pool from '../db/pool';
import { defaultQueue } from './queues';
import type { GenerateProductEmbeddingJobData } from './generateProductEmbedding';
import { calculateProgressiveFee } from '../services/aiUseCaseService';
import {
  findUnbilledUseCaseIdsForTenantInPeriod,
  stampBillingPeriodOnUseCases,
} from '../db/models/aiUseCase';
import { createCommissionReport } from '../db/models/commissionReport';
import { aggregateReportForTenantInPeriod } from '../services/platformCommissionService';

/** BullMQ repeat pattern: 00:05 UTC on the 1st of every month. */
const MONTHLY_SNAPSHOT_CRON = '5 0 1 * *';

export type MonthlyUseCaseSnapshotJobData = Record<string, never>;

/**
 * Returns the previous calendar month's UTC start (inclusive) and end (exclusive) bounds.
 * When this job runs on the 1st of the month, it snapshots the just-closed month.
 */
function previousMonthBounds(): {
  start: Date;
  endExclusive: Date;
  billingPeriod: string;
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed; current month
  const prevStart = new Date(Date.UTC(y, m - 1, 1));
  const prevEnd = new Date(Date.UTC(y, m, 1));
  const billingPeriod = `${prevStart.getUTCFullYear()}-${String(prevStart.getUTCMonth() + 1).padStart(2, '0')}`;
  return { start: prevStart, endExclusive: prevEnd, billingPeriod };
}

/**
 * Month-end billing snapshot for AI use cases.
 *
 * For each tenant that has unbilled use cases in the closing month:
 *  1. Lock their use case rows with FOR UPDATE (inside a transaction).
 *  2. Calculate the total progressive fee for all cases in that period.
 *  3. Distribute the fee proportionally across individual rows.
 *  4. Stamp the billing_period on all rows.
 *  5. Upsert a commission_reports row covering both order commission and use case fees.
 *
 * All per-tenant work runs in its own transaction, so a failure for one tenant
 * does not roll back others.
 */
export async function processMonthlyUseCaseSnapshot(): Promise<void> {
  const { start, endExclusive, billingPeriod } = previousMonthBounds();

  console.info('[snapshot] Starting monthly use case snapshot', { billingPeriod });

  const { rows: tenants } = await pool.query<{ tenant_id: string }>(
    `SELECT DISTINCT tenant_id
     FROM ai_use_cases
     WHERE status = 'completed'
       AND billing_status = 'unbilled'
       AND resolved_at >= $1
       AND resolved_at < $2`,
    [start, endExclusive],
  );

  console.info('[snapshot] Tenants to process', { count: tenants.length, billingPeriod });

  for (const { tenant_id: tenantId } of tenants) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ids = await findUnbilledUseCaseIdsForTenantInPeriod(tenantId, start, endExclusive, client);
      if (ids.length === 0) {
        await client.query('ROLLBACK');
        continue;
      }

      const totalFee = calculateProgressiveFee(ids.length);
      const feePerCase = ids.length > 0 ? Math.round((totalFee / ids.length) * 100) / 100 : 0;

      await stampBillingPeriodOnUseCases(ids, billingPeriod, feePerCase, client);

      // Aggregate order commission for the same period (read-only, no lock needed)
      const orderAgg = await aggregateReportForTenantInPeriod(tenantId, start, endExclusive);

      await createCommissionReport({
        tenant_id: tenantId,
        period_start: start,
        period_end: new Date(endExclusive.getTime() - 1),
        total_orders: orderAgg.total_orders,
        total_revenue: orderAgg.total_revenue,
        commission_amount: orderAgg.commission_amount,
        use_case_count: ids.length,
        use_case_amount: totalFee,
        status: 'unpaid',
      });

      await client.query('COMMIT');

      console.info('[snapshot] Tenant snapshot complete', {
        tenantId,
        billingPeriod,
        useCaseCount: ids.length,
        totalFee,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[snapshot] Failed to process tenant', { tenantId, billingPeriod, err });
    } finally {
      client.release();
    }
  }

  console.info('[snapshot] Monthly use case snapshot complete', { billingPeriod });
}

export async function initMonthlyUseCaseSnapshotScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    'monthlyUseCaseSnapshot',
    { pattern: MONTHLY_SNAPSHOT_CRON },
    {
      name: 'monthlyUseCaseSnapshot',
      data: {} as GenerateProductEmbeddingJobData,
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    },
  );

  console.info('[jobs] Monthly use case snapshot scheduler registered', {
    cron: MONTHLY_SNAPSHOT_CRON,
  });
}
