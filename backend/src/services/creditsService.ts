import pool from '../db/pool';
import { calculateProgressiveFee, outstandingUseCaseFeesForMonth } from './aiUseCaseService';

export interface CreditsSummary {
  commission_this_month: number;
  use_case_fees_this_month: number;
  use_case_count_this_month: number;
  ai_orders_this_month: number;
  estimated_invoice: number;
  total_unpaid_commission: number;
  total_unpaid_use_case_fees: number;
}

interface MonthUseCaseOutstandingRow {
  month_key: string;
  unbilled_count: number;
  total_count: number;
  billed_fees: number;
}

/** Outstanding use case fees for one month (billed + projected unbilled). */
function outstandingUseCaseFeesFromMonthRow(row: MonthUseCaseOutstandingRow): number {
  return outstandingUseCaseFeesForMonth(row.unbilled_count, row.total_count, row.billed_fees);
}

/**
 * Returns outstanding use case fee rows grouped by billing month.
 * total_count includes all completed cases in the month (for tier pricing).
 */
async function getUseCaseOutstandingByMonth(
  tenantId: string,
  rangeStart?: Date,
): Promise<MonthUseCaseOutstandingRow[]> {
  const params: unknown[] = [tenantId];
  const rangeFilter = rangeStart ? ' AND resolved_at >= $2' : '';
  if (rangeStart) {
    params.push(rangeStart);
  }

  const { rows } = await pool.query<{
    month_key: string;
    unbilled_count: string;
    total_count: string;
    billed_fees: string;
  }>(
    `WITH month_totals AS (
       SELECT
         to_char(date_trunc('month', resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month_key,
         COUNT(*)::text AS total_count
       FROM ai_use_cases
       WHERE tenant_id = $1
         AND status = 'completed'${rangeFilter}
       GROUP BY 1
     ),
     outstanding AS (
       SELECT
         to_char(date_trunc('month', resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month_key,
         COUNT(*) FILTER (WHERE billing_status = 'unbilled')::text AS unbilled_count,
         COALESCE(
           SUM(fee_amount) FILTER (WHERE billing_status = 'billed'),
           0
         )::text AS billed_fees
       FROM ai_use_cases
       WHERE tenant_id = $1
         AND status = 'completed'
         AND billing_status IN ('unbilled', 'billed')${rangeFilter}
       GROUP BY 1
     )
     SELECT
       o.month_key,
       o.unbilled_count,
       mt.total_count,
       o.billed_fees
     FROM outstanding o
     INNER JOIN month_totals mt ON mt.month_key = o.month_key`,
    params,
  );

  return rows.map((r) => ({
    month_key: r.month_key,
    unbilled_count: parseInt(r.unbilled_count, 10),
    total_count: parseInt(r.total_count, 10),
    billed_fees: parseFloat(r.billed_fees),
  }));
}

/**
 * Returns the total outstanding use case fees across all periods.
 */
async function getTotalOutstandingUseCaseFeesForTenant(tenantId: string): Promise<number> {
  const rows = await getUseCaseOutstandingByMonth(tenantId);
  const total = rows.reduce((sum, row) => sum + outstandingUseCaseFeesFromMonthRow(row), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Returns a complete current-month billing summary for the Credits dashboard.
 * All monetary fields reflect outstanding (unpaid/billed) amounts only — paid items are excluded.
 */
export async function getCreditsSummaryForTenant(tenantId: string): Promise<CreditsSummary> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

  const [orderRow, useCaseMonthRows, unpaidCommissionRow] = await Promise.all([
    pool.query<{
      commission_this_month: string;
      ai_orders_this_month: string;
    }>(
      `SELECT
         COALESCE(SUM(commission_amount), 0)::text AS commission_this_month,
         COUNT(*)::text AS ai_orders_this_month
       FROM orders
       WHERE tenant_id = $1
         AND is_commissionable = true
         AND commission_status IN ('unpaid', 'billed')
         AND created_at >= $2
         AND created_at < $3`,
      [tenantId, monthStart, monthEnd],
    ),

    getUseCaseOutstandingByMonth(tenantId, monthStart),

    pool.query<{ outstanding_commission: string }>(
      `SELECT COALESCE(SUM(commission_amount), 0)::text AS outstanding_commission
       FROM orders
       WHERE tenant_id = $1
         AND is_commissionable = true
         AND commission_status IN ('unpaid', 'billed')`,
      [tenantId],
    ),
  ]);

  const commissionThisMonth = parseFloat(orderRow.rows[0]?.commission_this_month ?? '0');
  const aiOrdersThisMonth = parseInt(orderRow.rows[0]?.ai_orders_this_month ?? '0', 10);
  const totalUnpaidCommission = parseFloat(unpaidCommissionRow.rows[0]?.outstanding_commission ?? '0');

  const currentMonthUseCase = useCaseMonthRows.find((r) => r.month_key === monthKey);
  const useCaseFeesThisMonth = currentMonthUseCase
    ? outstandingUseCaseFeesFromMonthRow(currentMonthUseCase)
    : 0;

  const { rows: useCaseCountRows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND status = 'completed'
       AND billing_status IN ('unbilled', 'billed')
       AND resolved_at >= $2
       AND resolved_at < $3`,
    [tenantId, monthStart, monthEnd],
  );
  const outstandingUseCaseCountThisMonth = parseInt(useCaseCountRows[0]?.count ?? '0', 10);

  const totalUnpaidUseCaseFees = await getTotalOutstandingUseCaseFeesForTenant(tenantId);

  return {
    commission_this_month: commissionThisMonth,
    use_case_fees_this_month: useCaseFeesThisMonth,
    use_case_count_this_month: outstandingUseCaseCountThisMonth,
    ai_orders_this_month: aiOrdersThisMonth,
    estimated_invoice: Math.round((commissionThisMonth + useCaseFeesThisMonth) * 100) / 100,
    total_unpaid_commission: totalUnpaidCommission,
    total_unpaid_use_case_fees: totalUnpaidUseCaseFees,
  };
}

export interface MonthlyBreakdownPoint {
  month_key: string;
  commission: number;
  use_case_fees: number;
  use_case_count: number;
}

/**
 * Returns the last N months of billing activity for chart display.
 * Shows total commission and use case fees generated each month regardless of payment status.
 */
export async function getMonthlyBreakdownForTenant(
  tenantId: string,
  monthsBack = 12,
): Promise<MonthlyBreakdownPoint[]> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const rangeStart = new Date(Date.UTC(y, m - (monthsBack - 1), 1));

  const [commissionRows, useCaseRows] = await Promise.all([
    pool.query<{ month_key: string; commission: string }>(
      `SELECT
         to_char(date_trunc('month', created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month_key,
         COALESCE(SUM(commission_amount), 0)::text AS commission
       FROM orders
       WHERE tenant_id = $1
         AND is_commissionable = true
         AND created_at >= $2
       GROUP BY 1`,
      [tenantId, rangeStart],
    ),

    pool.query<{ month_key: string; use_case_count: string }>(
      `SELECT
         to_char(date_trunc('month', resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month_key,
         COUNT(*)::text AS use_case_count
       FROM ai_use_cases
       WHERE tenant_id = $1
         AND status = 'completed'
         AND resolved_at >= $2
       GROUP BY 1`,
      [tenantId, rangeStart],
    ),
  ]);

  const commissionByKey = new Map(
    commissionRows.rows.map((r) => [r.month_key, parseFloat(r.commission)]),
  );
  const useCaseByKey = new Map(
    useCaseRows.rows.map((r) => [r.month_key, parseInt(r.use_case_count, 10)]),
  );

  const result: MonthlyBreakdownPoint[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const count = useCaseByKey.get(key) ?? 0;
    result.push({
      month_key: key,
      commission: commissionByKey.get(key) ?? 0,
      use_case_fees: calculateProgressiveFee(count),
      use_case_count: count,
    });
  }
  return result;
}

export interface DailyUseCasePoint {
  day: string;
  count: number;
}

/**
 * Returns the daily AI use case volume for the current calendar month.
 * Used for the analytics line chart on the Credits page.
 */
export async function getDailyUseCaseVolumeForTenant(
  tenantId: string,
): Promise<DailyUseCasePoint[]> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const { rows } = await pool.query<{ day: string; count: string }>(
    `SELECT
       to_char(date_trunc('day', resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
       COUNT(*)::text AS count
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND status = 'completed'
       AND resolved_at >= $2
       AND resolved_at < $3
     GROUP BY 1
     ORDER BY 1 ASC`,
    [tenantId, monthStart, monthEnd],
  );

  const byDay = new Map(rows.map((r) => [r.day, parseInt(r.count, 10)]));
  const daysInMonth = now.getUTCDate();
  const result: DailyUseCasePoint[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    result.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  return result;
}

export interface BillingHistoryRow {
  id: string;
  period_start: Date;
  period_end: Date;
  total_orders: number;
  total_revenue: number;
  commission_amount: number;
  use_case_count: number;
  use_case_amount: number;
  total_amount: number;
  status: string;
  created_at: Date;
}

/**
 * Returns paginated billing history (commission_reports rows) for a tenant.
 * Includes the combined total of commission + use case fees per period.
 */
export async function getBillingHistoryForTenant(
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ rows: BillingHistoryRow[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM commission_reports WHERE tenant_id = $1',
    [tenantId],
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<{
    id: string;
    period_start: Date;
    period_end: Date;
    total_orders: string;
    total_revenue: string;
    commission_amount: string;
    use_case_count: string;
    use_case_amount: string;
    status: string;
    created_at: Date;
  }>(
    `SELECT id, period_start, period_end, total_orders, total_revenue,
            commission_amount, use_case_count, use_case_amount, status, created_at
     FROM commission_reports
     WHERE tenant_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );

  return {
    rows: rows.map((r) => {
      const commission = parseFloat(r.commission_amount as unknown as string);
      const useCaseFee = parseFloat(r.use_case_amount as unknown as string);
      return {
        id: r.id,
        period_start: r.period_start,
        period_end: r.period_end,
        total_orders: parseInt(r.total_orders as unknown as string, 10),
        total_revenue: parseFloat(r.total_revenue as unknown as string),
        commission_amount: commission,
        use_case_count: parseInt(r.use_case_count as unknown as string, 10),
        use_case_amount: useCaseFee,
        total_amount: Math.round((commission + useCaseFee) * 100) / 100,
        status: r.status,
        created_at: r.created_at,
      };
    }),
    total,
  };
}
