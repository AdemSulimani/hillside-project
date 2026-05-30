import pool from '../db/pool';
import { findTenantById } from '../db/models/tenant';
import type { CommissionStatus } from '../db/models/order';

/** Confirmed-or-beyond lifecycle: commission counts only after confirmation. */
const AI_ORDER_STATUSES_SQL = "('confirmed', 'processing', 'shipped', 'delivered')";

export interface AdminDashboardSummary {
  total_businesses: number;
  total_ai_completed_orders: number;
  total_commission_earned: number;
  total_unpaid_commission: number;
  total_paid_commission: number;
}

export async function getAdminDashboardSummary(): Promise<AdminDashboardSummary> {
  const { rows } = await pool.query<{
    total_businesses: string;
    total_ai_completed_orders: string;
    total_commission_earned: string;
    total_unpaid_commission: string;
    total_paid_commission: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM tenants) AS total_businesses,
       (SELECT COUNT(*)::text FROM orders o
         WHERE o.is_commissionable = true
           AND o.status IN ${AI_ORDER_STATUSES_SQL}) AS total_ai_completed_orders,
       (SELECT COALESCE(SUM(o.commission_amount), 0)::text FROM orders o
         WHERE o.is_commissionable = true) AS total_commission_earned,
       (SELECT COALESCE(SUM(o.commission_amount), 0)::text FROM orders o
         WHERE o.is_commissionable = true AND o.commission_status = 'unpaid') AS total_unpaid_commission,
       (SELECT COALESCE(SUM(o.commission_amount), 0)::text FROM orders o
         WHERE o.is_commissionable = true AND o.commission_status = 'paid') AS total_paid_commission`,
  );
  const r = rows[0];
  return {
    total_businesses: parseInt(r.total_businesses, 10),
    total_ai_completed_orders: parseInt(r.total_ai_completed_orders, 10),
    total_commission_earned: parseFloat(r.total_commission_earned),
    total_unpaid_commission: parseFloat(r.total_unpaid_commission),
    total_paid_commission: parseFloat(r.total_paid_commission),
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
  }>(
    `SELECT
       t.id AS tenant_id,
       t.name AS business_name,
       t.plan,
       COUNT(o.id)::text AS total_orders,
       COUNT(o.id) FILTER (
         WHERE o.is_commissionable = true AND o.status IN ${AI_ORDER_STATUSES_SQL}
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
       )::text AS paid_cnt
     FROM tenants t
     LEFT JOIN orders o ON o.tenant_id = t.id
     GROUP BY t.id
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

    return {
      tenant_id: r.tenant_id,
      business_name: r.business_name,
      plan: r.plan,
      total_orders: parseInt(r.total_orders, 10),
      total_ai_completed_orders: parseInt(r.total_ai_completed_orders, 10),
      total_commission_owed: parseFloat(r.total_commission_owed),
      aggregate_commission_status,
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
}

/**
 * Commission earned per calendar month (UTC), based on order creation time,
 * for commissionable orders that reached confirmed-or-beyond status.
 */
export async function getCommissionEarnedByMonthUtc(
  monthsBack = 12,
): Promise<CommissionMonthPoint[]> {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const rangeStart = new Date(Date.UTC(y, m - (monthsBack - 1), 1, 0, 0, 0, 0));

  const { rows } = await pool.query<{ month_key: string; commission: string }>(
    `SELECT
       to_char(date_trunc('month', o.created_at AT TIME ZONE 'UTC'), 'YYYY-MM') AS month_key,
       COALESCE(SUM(o.commission_amount), 0)::text AS commission
     FROM orders o
     WHERE o.is_commissionable = true
       AND o.created_at >= $1::timestamptz
     GROUP BY 1
     ORDER BY 1 ASC`,
    [rangeStart],
  );

  const byKey = new Map(rows.map((r) => [r.month_key, parseFloat(r.commission)]));

  const out: CommissionMonthPoint[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    out.push({ month_key: key, commission: byKey.get(key) ?? 0 });
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
       COUNT(*) FILTER (WHERE status IN ${AI_ORDER_STATUSES_SQL})::text AS commissionable_ai_orders,
       COALESCE(
         SUM(commission_amount) FILTER (
           WHERE status IN ${AI_ORDER_STATUSES_SQL} AND commission_status = 'unpaid'
         ),
         0
       )::text AS commission_unpaid,
       COALESCE(
         SUM(commission_amount) FILTER (
           WHERE status IN ${AI_ORDER_STATUSES_SQL} AND commission_status = 'billed'
         ),
         0
       )::text AS commission_billed,
       COALESCE(
         SUM(commission_amount) FILTER (
           WHERE status IN ${AI_ORDER_STATUSES_SQL} AND commission_status = 'paid'
         ),
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
