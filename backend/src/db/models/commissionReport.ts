import pool from '../pool';

export type CommissionReportBillingStatus = 'unpaid' | 'billed' | 'paid';

export interface CommissionReport {
  id: string;
  tenant_id: string;
  period_start: Date;
  period_end: Date;
  total_orders: number;
  total_revenue: number;
  commission_amount: number;
  status: CommissionReportBillingStatus;
  created_at: Date;
}

type ReportRow = Omit<CommissionReport, 'total_revenue' | 'commission_amount'> & {
  total_revenue: string | number;
  commission_amount: string | number;
};

function rowToReport(row: ReportRow): CommissionReport {
  return {
    ...row,
    total_revenue: Number(row.total_revenue),
    commission_amount: Number(row.commission_amount),
  };
}

export interface CreateCommissionReportInput {
  tenant_id: string;
  period_start: Date;
  period_end: Date;
  total_orders: number;
  total_revenue: number;
  commission_amount: number;
  status?: CommissionReportBillingStatus;
}

export async function createCommissionReport(input: CreateCommissionReportInput): Promise<CommissionReport> {
  const { rows } = await pool.query<ReportRow>(
    `INSERT INTO commission_reports (
      tenant_id, period_start, period_end, total_orders, total_revenue, commission_amount, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *`,
    [
      input.tenant_id,
      input.period_start,
      input.period_end,
      input.total_orders,
      input.total_revenue,
      input.commission_amount,
      input.status ?? 'unpaid',
    ],
  );
  return rowToReport(rows[0]);
}

export async function listCommissionReportsForTenant(tenantId: string): Promise<CommissionReport[]> {
  const { rows } = await pool.query<ReportRow>(
    `SELECT * FROM commission_reports
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows.map(rowToReport);
}

export interface CommissionReportListRow extends CommissionReport {
  business_name: string;
}

type ReportListQueryRow = ReportRow & { business_name: string };

export async function listAllCommissionReportsPage(
  page: number,
  limit: number,
): Promise<{ rows: CommissionReportListRow[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM commission_reports',
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<ReportListQueryRow>(
    `SELECT cr.*, t.name AS business_name
     FROM commission_reports cr
     INNER JOIN tenants t ON t.id = cr.tenant_id
     ORDER BY cr.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  const mapped: CommissionReportListRow[] = rows.map((row) => {
    const { business_name, ...cr } = row;
    return { ...rowToReport(cr), business_name };
  });

  return { rows: mapped, total };
}

export async function updateCommissionReportStatusById(
  reportId: string,
  status: CommissionReportBillingStatus,
): Promise<CommissionReportListRow | null> {
  const { rows } = await pool.query<ReportListQueryRow>(
    `UPDATE commission_reports cr
     SET status = $2::varchar
     FROM tenants t
     WHERE cr.id = $1::uuid AND t.id = cr.tenant_id
     RETURNING cr.*, t.name AS business_name`,
    [reportId, status],
  );
  const row = rows[0];
  if (!row) return null;
  const { business_name, ...cr } = row;
  return { ...rowToReport(cr), business_name };
}

export async function deleteCommissionReportById(reportId: string): Promise<boolean> {
  const result = await pool.query('DELETE FROM commission_reports WHERE id = $1::uuid', [reportId]);
  return (result.rowCount ?? 0) > 0;
}
