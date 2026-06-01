import pool from '../db/pool';
import { findTenantById } from '../db/models/tenant';
import type { CommissionStatus } from '../db/models/order';
import type { AiUseCaseBillingStatus } from '../db/models/aiUseCase';

/** Confirmed-or-beyond lifecycle: commission counts only after confirmation. */
const AI_ORDER_STATUSES_SQL = "('confirmed', 'processing', 'shipped', 'delivered')";

export interface AdminDashboardSummary {
  total_businesses: number;
  /**
   * Count of ALL commissionable orders (is_commissionable = true), regardless of
   * fulfillment status. Matches the same scope used by the commission amount sums.
   */
  total_ai_completed_orders: number;
  total_commission_earned: number;
  total_unpaid_commission: number;
  total_paid_commission: number;
  total_ai_completed_use_cases: number;
  /**
   * Completed use cases with billing_status = 'unbilled'.
   * fee_amount is NULL until the month-end billing job stamps it.
   */
  total_unbilled_use_cases: number;
  /** Sum of fee_amount for completed use cases that have been billed or paid (fee calculated). */
  total_use_case_fees_earned: number;
  /** Sum of fee_amount for completed use cases that are billed but not yet paid. */
  total_unpaid_use_case_fees: number;
}

export async function getAdminDashboardSummary(): Promise<AdminDashboardSummary> {
  const { rows } = await pool.query<{
    total_businesses: string;
    total_ai_completed_orders: string;
    total_commission_earned: string;
    total_unpaid_commission: string;
    total_paid_commission: string;
    total_ai_completed_use_cases: string;
    total_unbilled_use_cases: string;
    total_use_case_fees_earned: string;
    total_unpaid_use_case_fees: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM tenants) AS total_businesses,
       -- Count ALL commissionable orders so the count is in sync with the commission sums below.
       -- Draft / cancelled / refunded commissionable orders are intentionally included.
       (SELECT COUNT(*)::text FROM orders o
         WHERE o.is_commissionable = true) AS total_ai_completed_orders,
       (SELECT COALESCE(SUM(o.commission_amount), 0)::text FROM orders o
         WHERE o.is_commissionable = true) AS total_commission_earned,
       (SELECT COALESCE(SUM(o.commission_amount), 0)::text FROM orders o
         WHERE o.is_commissionable = true AND o.commission_status = 'unpaid') AS total_unpaid_commission,
       (SELECT COALESCE(SUM(o.commission_amount), 0)::text FROM orders o
         WHERE o.is_commissionable = true AND o.commission_status = 'paid') AS total_paid_commission,
       (SELECT COUNT(*)::text FROM ai_use_cases
         WHERE status = 'completed') AS total_ai_completed_use_cases,
       -- Unbilled use cases haven't had fee_amount stamped yet (billing job not run).
       (SELECT COUNT(*)::text FROM ai_use_cases
         WHERE status = 'completed'
           AND billing_status = 'unbilled') AS total_unbilled_use_cases,
       (SELECT COALESCE(SUM(fee_amount), 0)::text FROM ai_use_cases
         WHERE status = 'completed'
           AND billing_status IN ('billed', 'paid')) AS total_use_case_fees_earned,
       (SELECT COALESCE(SUM(fee_amount), 0)::text FROM ai_use_cases
         WHERE status = 'completed'
           AND billing_status = 'billed') AS total_unpaid_use_case_fees`,
  );
  const r = rows[0];
  return {
    total_businesses: parseInt(r.total_businesses, 10),
    total_ai_completed_orders: parseInt(r.total_ai_completed_orders, 10),
    total_commission_earned: parseFloat(r.total_commission_earned),
    total_unpaid_commission: parseFloat(r.total_unpaid_commission),
    total_paid_commission: parseFloat(r.total_paid_commission),
    total_ai_completed_use_cases: parseInt(r.total_ai_completed_use_cases, 10),
    total_unbilled_use_cases: parseInt(r.total_unbilled_use_cases, 10),
    total_use_case_fees_earned: parseFloat(r.total_use_case_fees_earned),
    total_unpaid_use_case_fees: parseFloat(r.total_unpaid_use_case_fees),
  };
}

export interface AdminBusinessRow {
  tenant_id: string;
  business_name: string;
  plan: string;
  total_orders: number;
  total_ai_completed_orders: number;
  total_commission_owed: number;
  aggregate_commission_status: CommissionStatus | 'clear';
  total_use_cases: number;
  /** Sum of fee_amount for billed (invoiced, unpaid) completed use cases. */
  total_use_case_fees_owed: number;
  aggregate_use_case_billing_status: AiUseCaseBillingStatus | 'clear';
}

export async function listAdminBusinessesPage(
  page: number,
  limit: number,
): Promise<{ rows: AdminBusinessRow[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM tenants',
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<{
    tenant_id: string;
    business_name: string;
    plan: string;
    total_orders: string;
    total_ai_completed_orders: string;
    total_commission_owed: string;
    unpaid_cnt: string;
    billed_cnt: string;
    paid_cnt: string;
    total_use_cases: string;
    total_use_case_fees_owed: string;
    uc_unbilled_cnt: string;
    uc_billed_cnt: string;
    uc_paid_cnt: string;
  }>(
    `SELECT
       t.id AS tenant_id,
       t.name AS business_name,
       t.plan,
       COUNT(o.id)::text AS total_orders,
       -- Count ALL commissionable orders to keep in sync with the commission amount sums.
       COUNT(o.id) FILTER (
         WHERE o.is_commissionable = true
       )::text AS total_ai_completed_orders,
       COALESCE(
         SUM(o.commission_amount) FILTER (
           WHERE o.is_commissionable = true AND o.commission_status = 'unpaid'
         ),
         0
       )::text AS total_commission_owed,
       COUNT(o.id) FILTER (
         WHERE o.is_commissionable = true AND o.commission_status = 'unpaid'
       )::text AS unpaid_cnt,
       COUNT(o.id) FILTER (
         WHERE o.is_commissionable = true AND o.commission_status = 'billed'
       )::text AS billed_cnt,
       COUNT(o.id) FILTER (
         WHERE o.is_commissionable = true AND o.commission_status = 'paid'
       )::text AS paid_cnt,
       uc.total_use_cases,
       uc.total_use_case_fees_owed,
       uc.uc_unbilled_cnt,
       uc.uc_billed_cnt,
       uc.uc_paid_cnt
     FROM tenants t
     LEFT JOIN orders o ON o.tenant_id = t.id
     CROSS JOIN LATERAL (
       SELECT
         COUNT(*)::text AS total_use_cases,
         COALESCE(SUM(fee_amount) FILTER (WHERE billing_status = 'billed'), 0)::text AS total_use_case_fees_owed,
         COUNT(*) FILTER (WHERE billing_status = 'unbilled')::text AS uc_unbilled_cnt,
         COUNT(*) FILTER (WHERE billing_status = 'billed')::text AS uc_billed_cnt,
         COUNT(*) FILTER (WHERE billing_status = 'paid')::text AS uc_paid_cnt
       FROM ai_use_cases
       WHERE tenant_id = t.id AND status = 'completed'
     ) uc
     GROUP BY t.id, t.name, t.plan,
              uc.total_use_cases, uc.total_use_case_fees_owed,
              uc.uc_unbilled_cnt, uc.uc_billed_cnt, uc.uc_paid_cnt
     ORDER BY t.name ASC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  const mapped: AdminBusinessRow[] = rows.map((r) => {
    const unpaid = parseInt(r.unpaid_cnt, 10);
    const billed = parseInt(r.billed_cnt, 10);
    const paid = parseInt(r.paid_cnt, 10);
    let aggregate_commission_status: CommissionStatus | 'clear' = 'clear';
    if (unpaid > 0) aggregate_commission_status = 'unpaid';
    else if (billed > 0) aggregate_commission_status = 'billed';
    else if (paid > 0) aggregate_commission_status = 'paid';

    const ucUnbilled = parseInt(r.uc_unbilled_cnt, 10);
    const ucBilled = parseInt(r.uc_billed_cnt, 10);
    const ucPaid = parseInt(r.uc_paid_cnt, 10);
    let aggregate_use_case_billing_status: AiUseCaseBillingStatus | 'clear' = 'clear';
    if (ucUnbilled > 0) aggregate_use_case_billing_status = 'unbilled';
    else if (ucBilled > 0) aggregate_use_case_billing_status = 'billed';
    else if (ucPaid > 0) aggregate_use_case_billing_status = 'paid';

    return {
      tenant_id: r.tenant_id,
      business_name: r.business_name,
      plan: r.plan,
      total_orders: parseInt(r.total_orders, 10),
      total_ai_completed_orders: parseInt(r.total_ai_completed_orders, 10),
      total_commission_owed: parseFloat(r.total_commission_owed),
      aggregate_commission_status,
      total_use_cases: parseInt(r.total_use_cases, 10),
      total_use_case_fees_owed: parseFloat(r.total_use_case_fees_owed),
      aggregate_use_case_billing_status,
    };
  });

  return { rows: mapped, total };
}

export interface CommissionableOrderRow {
  id: string;
  customer_name: string;
  product_name: string;
  total_price: number;
  commission_amount: number;
  created_at: Date;
  commission_status: CommissionStatus;
}

export interface CommissionableOrdersDateRange {
  rangeStartInclusive: Date;
  rangeEndExclusive: Date;
}

export async function listCommissionableOrdersForTenant(
  tenantId: string,
  page: number,
  limit: number,
  dateRange?: CommissionableOrdersDateRange | null,
): Promise<{ orders: CommissionableOrderRow[]; total: number }> {
  const offset = (page - 1) * limit;

  const rangeSql =
    dateRange != null
      ? ` AND created_at >= $2::timestamptz AND created_at < $3::timestamptz`
      : '';
  const countParams =
    dateRange != null
      ? [tenantId, dateRange.rangeStartInclusive, dateRange.rangeEndExclusive]
      : [tenantId];
  const listParams =
    dateRange != null
      ? [tenantId, dateRange.rangeStartInclusive, dateRange.rangeEndExclusive, limit, offset]
      : [tenantId, limit, offset];

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM orders
     WHERE tenant_id = $1 AND is_commissionable = true${rangeSql}`,
    countParams,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  type Row = {
    id: string;
    customer_name: string;
    product_name: string;
    total_price: string | number;
    commission_amount: string | number;
    created_at: Date;
    commission_status: CommissionStatus;
  };

  const limitIdx = dateRange != null ? 4 : 2;
  const offsetIdx = dateRange != null ? 5 : 3;

  const { rows } = await pool.query<Row>(
    `SELECT id, customer_name, product_name, total_price, commission_amount, created_at, commission_status
     FROM orders
     WHERE tenant_id = $1 AND is_commissionable = true${rangeSql}
     ORDER BY created_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    listParams,
  );

  const orders: CommissionableOrderRow[] = rows.map((r) => ({
    id: r.id,
    customer_name: r.customer_name,
    product_name: r.product_name,
    total_price: Number(r.total_price),
    commission_amount: Number(r.commission_amount),
    created_at: r.created_at,
    commission_status: r.commission_status,
  }));

  return { orders, total };
}

export interface TenantCommissionSummary {
  tenant_id: string;
  business_name: string;
  total_orders_this_month: number;
  ai_completed_orders_this_month: number;
  total_commission_owed: number;
}

export async function getTenantCommissionSummary(
  tenantId: string,
  monthStartInclusive: Date,
  monthEndExclusive: Date,
): Promise<TenantCommissionSummary | null> {
  const tenant = await findTenantById(tenantId);
  if (!tenant) return null;

  const monthAgg = await pool.query<{
    total_orders_this_month: string;
    ai_completed_orders_this_month: string;
  }>(
    `SELECT
       COUNT(*)::text AS total_orders_this_month,
       COUNT(*) FILTER (
         WHERE is_commissionable = true AND status IN ${AI_ORDER_STATUSES_SQL}
       )::text AS ai_completed_orders_this_month
     FROM orders
     WHERE tenant_id = $1
       AND created_at >= $2::timestamptz
       AND created_at < $3::timestamptz`,
    [tenantId, monthStartInclusive, monthEndExclusive],
  );

  const owed = await pool.query<{ total_commission_owed: string }>(
    `SELECT COALESCE(SUM(commission_amount), 0)::text AS total_commission_owed
     FROM orders
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND commission_status = 'unpaid'`,
    [tenantId],
  );

  const r = monthAgg.rows[0];
  return {
    tenant_id: tenant.id,
    business_name: tenant.name,
    total_orders_this_month: parseInt(r.total_orders_this_month, 10),
    ai_completed_orders_this_month: parseInt(r.ai_completed_orders_this_month, 10),
    total_commission_owed: parseFloat(owed.rows[0].total_commission_owed),
  };
}

export interface CommissionMonthPoint {
  month_key: string;
  commission: number;
  use_case_fees: number;
}

/**
 * Commission earned per calendar month (UTC), based on order creation time,
 * for commissionable orders that reached confirmed-or-beyond status.
 * Also includes AI use case fees (billed + paid) resolved in the same month.
 */
export async function getCommissionEarnedByMonthUtc(
  monthsBack = 12,
): Promise<CommissionMonthPoint[]> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const rangeStart = new Date(Date.UTC(y, m - (monthsBack - 1), 1, 0, 0, 0, 0));

  const [orderRows, useCaseRows] = await Promise.all([
    pool.query<{ month_key: string; commission: string }>(
      `SELECT
         to_char(date_trunc('month', o.created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month_key,
         COALESCE(SUM(o.commission_amount), 0)::text AS commission
       FROM orders o
       WHERE o.is_commissionable = true
         AND o.created_at >= $1::timestamptz
       GROUP BY 1
       ORDER BY 1 ASC`,
      [rangeStart],
    ),
    pool.query<{ month_key: string; use_case_fees: string }>(
      `SELECT
         to_char(date_trunc('month', uc.resolved_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month_key,
         COALESCE(SUM(uc.fee_amount), 0)::text AS use_case_fees
       FROM ai_use_cases uc
       WHERE uc.status = 'completed'
         AND uc.billing_status IN ('billed', 'paid')
         AND uc.resolved_at >= $1::timestamptz
       GROUP BY 1
       ORDER BY 1 ASC`,
      [rangeStart],
    ),
  ]);

  const commissionByKey = new Map(orderRows.rows.map((r) => [r.month_key, parseFloat(r.commission)]));
  const ucFeesByKey = new Map(useCaseRows.rows.map((r) => [r.month_key, parseFloat(r.use_case_fees)]));

  const out: CommissionMonthPoint[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({
      month_key: key,
      commission: commissionByKey.get(key) ?? 0,
      use_case_fees: ucFeesByKey.get(key) ?? 0,
    });
  }
  return out;
}

export interface TenantCommissionPeriodStats {
  commissionable_ai_orders: number;
  commission_unpaid: number;
  commission_billed: number;
  commission_paid: number;
}

export async function getTenantCommissionPeriodStats(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
): Promise<TenantCommissionPeriodStats> {
  const { rows } = await pool.query<{
    commissionable_ai_orders: string;
    commission_unpaid: string;
    commission_billed: string;
    commission_paid: string;
  }>(
    `SELECT
       -- Count ALL commissionable orders in the period (consistent with the businesses list aggregate).
       COUNT(*)::text AS commissionable_ai_orders,
       COALESCE(
         SUM(commission_amount) FILTER (WHERE commission_status = 'unpaid'),
         0
       )::text AS commission_unpaid,
       COALESCE(
         SUM(commission_amount) FILTER (WHERE commission_status = 'billed'),
         0
       )::text AS commission_billed,
       COALESCE(
         SUM(commission_amount) FILTER (WHERE commission_status = 'paid'),
         0
       )::text AS commission_paid
     FROM orders
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND created_at >= $2::timestamptz
       AND created_at < $3::timestamptz`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  const r = rows[0];
  return {
    commissionable_ai_orders: parseInt(r.commissionable_ai_orders, 10),
    commission_unpaid: parseFloat(r.commission_unpaid),
    commission_billed: parseFloat(r.commission_billed),
    commission_paid: parseFloat(r.commission_paid),
  };
}

export async function aggregateReportForTenantInPeriod(
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<{ total_orders: number; total_revenue: number; commission_amount: number }> {
  const { rows } = await pool.query<{
    total_orders: string;
    total_revenue: string;
    commission_amount: string;
  }>(
    `SELECT
       COUNT(*)::text AS total_orders,
       COALESCE(SUM(total_price), 0)::text AS total_revenue,
       COALESCE(SUM(commission_amount), 0)::text AS commission_amount
     FROM orders
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND created_at::date >= $2::date
       AND created_at::date <= $3::date`,
    [tenantId, periodStart, periodEnd],
  );
  const r = rows[0];
  return {
    total_orders: parseInt(r.total_orders, 10),
    total_revenue: parseFloat(r.total_revenue),
    commission_amount: parseFloat(r.commission_amount),
  };
}

export interface TenantUseCasePeriodStats {
  completed_use_cases: number;
  /** Cases with billing_status = 'unbilled' (fee not yet calculated/invoiced). */
  use_case_unbilled: number;
  /** Cases with billing_status = 'billed' (invoiced but unpaid). */
  use_case_billed: number;
  /** Cases with billing_status = 'paid'. */
  use_case_paid: number;
  /** Sum of fee_amount for unbilled cases (usually 0 until billing period job runs). */
  use_case_fees_unbilled: number;
  /** Sum of fee_amount for billed (invoiced, unpaid) cases. */
  use_case_fees_billed: number;
  /** Sum of fee_amount for paid cases. */
  use_case_fees_paid: number;
}

export async function getTenantUseCasePeriodStats(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
): Promise<TenantUseCasePeriodStats> {
  const { rows } = await pool.query<{
    completed_use_cases: string;
    use_case_unbilled: string;
    use_case_billed: string;
    use_case_paid: string;
    use_case_fees_unbilled: string;
    use_case_fees_billed: string;
    use_case_fees_paid: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed')::text AS completed_use_cases,
       COUNT(*) FILTER (WHERE status = 'completed' AND billing_status = 'unbilled')::text AS use_case_unbilled,
       COUNT(*) FILTER (WHERE status = 'completed' AND billing_status = 'billed')::text AS use_case_billed,
       COUNT(*) FILTER (WHERE status = 'completed' AND billing_status = 'paid')::text AS use_case_paid,
       COALESCE(
         SUM(fee_amount) FILTER (WHERE status = 'completed' AND billing_status = 'unbilled'),
         0
       )::text AS use_case_fees_unbilled,
       COALESCE(
         SUM(fee_amount) FILTER (WHERE status = 'completed' AND billing_status = 'billed'),
         0
       )::text AS use_case_fees_billed,
       COALESCE(
         SUM(fee_amount) FILTER (WHERE status = 'completed' AND billing_status = 'paid'),
         0
       )::text AS use_case_fees_paid
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND resolved_at >= $2::timestamptz
       AND resolved_at < $3::timestamptz`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  const r = rows[0];
  return {
    completed_use_cases: parseInt(r.completed_use_cases, 10),
    use_case_unbilled: parseInt(r.use_case_unbilled, 10),
    use_case_billed: parseInt(r.use_case_billed, 10),
    use_case_paid: parseInt(r.use_case_paid, 10),
    use_case_fees_unbilled: parseFloat(r.use_case_fees_unbilled),
    use_case_fees_billed: parseFloat(r.use_case_fees_billed),
    use_case_fees_paid: parseFloat(r.use_case_fees_paid),
  };
}

/** Worst status among orders in the report period: unpaid > billed > paid. */
export type CommissionReportDerivedStatus = 'unpaid' | 'billed' | 'paid';

export async function deriveCommissionReportStatusForTenantPeriod(
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<CommissionReportDerivedStatus> {
  const { rows } = await pool.query<{
    unpaid: string;
    billed: string;
    paid: string;
    total: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE commission_status = 'unpaid')::text AS unpaid,
       COUNT(*) FILTER (WHERE commission_status = 'billed')::text AS billed,
       COUNT(*) FILTER (WHERE commission_status = 'paid')::text AS paid,
       COUNT(*)::text AS total
     FROM orders
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND status IN ${AI_ORDER_STATUSES_SQL}
       AND created_at::date >= $2::date
       AND created_at::date <= $3::date`,
    [tenantId, periodStart, periodEnd],
  );
  const r = rows[0];
  const total = parseInt(r.total, 10);
  if (total === 0) {
    return 'unpaid';
  }
  const unpaid = parseInt(r.unpaid, 10);
  const billed = parseInt(r.billed, 10);
  if (unpaid > 0) {
    return 'unpaid';
  }
  if (billed > 0) {
    return 'billed';
  }
  return 'paid';
}
