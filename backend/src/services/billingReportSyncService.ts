import type { PoolClient } from 'pg';
import type { CommissionReportBillingStatus } from '../db/models/commissionReport';
import {
  listBillingMonthsForUseCasesInPeriod,
  markUseCasesBilledInResolvedPeriod,
  markUseCasesPaidInResolvedPeriod,
  markUseCasesUnbilledInResolvedPeriod,
} from '../db/models/aiUseCase';
import {
  markOrdersCommissionBilledInPeriod,
  markOrdersCommissionPaidInPeriod,
  markOrdersCommissionUnpaidInPeriod,
} from '../db/models/order';
import { ensureTenantBillingMonthFeesStamped } from './aiUseCaseService';

export interface BillingPeriodUtcRange {
  start: Date;
  endExclusive: Date;
}

/** Converts inclusive YYYY-MM-DD period bounds to a UTC half-open range. */
export function reportPeriodToUtcRange(periodStart: Date, periodEnd: Date): BillingPeriodUtcRange {
  const start = new Date(
    Date.UTC(
      periodStart.getUTCFullYear(),
      periodStart.getUTCMonth(),
      periodStart.getUTCDate(),
    ),
  );
  const endDay = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()),
  );
  const endExclusive = new Date(endDay.getTime() + 86400000);
  return { start, endExclusive };
}

export interface BillingSyncResult {
  orders_updated: number;
  use_cases_updated: number;
}

/**
 * Stamps progressive-tier fees for every billing month touched by the report period
 * so use case rows have fee_amount before status transitions.
 */
async function stampUseCaseFeesForReportPeriod(
  tenantId: string,
  range: BillingPeriodUtcRange,
  client: PoolClient,
): Promise<void> {
  const billingMonths = await listBillingMonthsForUseCasesInPeriod(
    tenantId,
    range.start,
    range.endExclusive,
    client,
  );
  for (const billingMonth of billingMonths) {
    await ensureTenantBillingMonthFeesStamped(tenantId, billingMonth, client);
  }
}

/**
 * Applies a billing report status to the underlying commission orders and AI use cases
 * for the report's date range only. Items outside the period are untouched.
 */
export async function syncUnderlyingBillingForReportStatus(
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
  status: CommissionReportBillingStatus,
  client: PoolClient,
): Promise<BillingSyncResult> {
  const range = reportPeriodToUtcRange(periodStart, periodEnd);

  if (status === 'billed' || status === 'paid') {
    await stampUseCaseFeesForReportPeriod(tenantId, range, client);
  }

  let ordersUpdated = 0;
  let useCasesUpdated = 0;

  if (status === 'unpaid') {
    [ordersUpdated, useCasesUpdated] = await Promise.all([
      markOrdersCommissionUnpaidInPeriod(tenantId, range.start, range.endExclusive, client),
      markUseCasesUnbilledInResolvedPeriod(tenantId, range.start, range.endExclusive, client),
    ]);
  } else if (status === 'billed') {
    [ordersUpdated, useCasesUpdated] = await Promise.all([
      markOrdersCommissionBilledInPeriod(tenantId, range.start, range.endExclusive, client),
      markUseCasesBilledInResolvedPeriod(tenantId, range.start, range.endExclusive, client),
    ]);
  } else {
    [ordersUpdated, useCasesUpdated] = await Promise.all([
      markOrdersCommissionPaidInPeriod(tenantId, range.start, range.endExclusive, client),
      markUseCasesPaidInResolvedPeriod(tenantId, range.start, range.endExclusive, client),
    ]);
  }

  return { orders_updated: ordersUpdated, use_cases_updated: useCasesUpdated };
}
