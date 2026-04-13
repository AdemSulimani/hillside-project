import adminApi from '@/lib/adminApi';
import type { ApiResponse, PaginatedResponse, Tenant } from '@/types';

export interface AdminDashboardSummary {
  total_businesses: number;
  total_ai_completed_orders: number;
  total_commission_earned: number;
  total_unpaid_commission: number;
  total_paid_commission: number;
}

export interface AdminBusinessRow {
  tenant_id: string;
  business_name: string;
  plan: string;
  total_orders: number;
  total_ai_completed_orders: number;
  total_commission_owed: number;
  aggregate_commission_status: 'unpaid' | 'billed' | 'paid' | 'clear';
}

export interface CommissionMonthPoint {
  month_key: string;
  commission: number;
}

export interface CommissionableOrderRow {
  id: string;
  customer_name: string;
  product_name: string;
  total_price: number;
  commission_amount: number;
  created_at: string;
  commission_status: 'unpaid' | 'billed' | 'paid';
}

export interface ChannelAdminSummary {
  id: string;
  type: string;
  name: string;
  webhook_verified: boolean;
  ai_enabled: boolean;
}

export interface TenantCommissionPeriodStats {
  commissionable_ai_orders: number;
  commission_unpaid: number;
  commission_billed: number;
  commission_paid: number;
}

export interface CommissionReportRow {
  id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  total_orders: number;
  total_revenue: number;
  commission_amount: number;
  status: 'unpaid' | 'billed' | 'paid';
  created_at: string;
  business_name: string;
}

export async function adminLogin(email: string, password: string) {
  const { data } = await adminApi.post<
    ApiResponse<{ accessToken: string; owner: { id: string; email: string } }>
  >('/admin/auth/login', { email, password });
  return data.data!;
}

export async function fetchAdminDashboardSummary() {
  const { data } = await adminApi.get<ApiResponse<AdminDashboardSummary>>('/admin/dashboard/summary');
  return data.data!;
}

export async function fetchAdminCommissionByMonth() {
  const { data } = await adminApi.get<ApiResponse<{ series: CommissionMonthPoint[] }>>(
    '/admin/dashboard/commission-by-month',
  );
  return data.data!.series;
}

export async function fetchAdminBusinesses(page: number, limit: number) {
  const { data } = await adminApi.get<PaginatedResponse<AdminBusinessRow>>('/admin/businesses', {
    params: { page, limit },
  });
  return { rows: data.data ?? [], pagination: data.pagination };
}

export async function fetchAdminBusinessOverview(tenantId: string) {
  const { data } = await adminApi.get<
    ApiResponse<{ tenant: Tenant; channels: ChannelAdminSummary[] }>
  >(`/admin/businesses/${tenantId}/overview`);
  return data.data!;
}

export async function fetchAdminBusinessPeriodStats(
  tenantId: string,
  periodStart: string,
  periodEnd: string,
) {
  const { data } = await adminApi.get<ApiResponse<TenantCommissionPeriodStats>>(
    `/admin/businesses/${tenantId}/period-stats`,
    { params: { period_start: periodStart, period_end: periodEnd } },
  );
  return data.data!;
}

export async function fetchAdminCommissionableOrders(
  tenantId: string,
  page: number,
  limit: number,
  period?: { start: string; end: string },
) {
  const params: Record<string, string | number> = { page, limit };
  if (period) {
    params.period_start = period.start;
    params.period_end = period.end;
  }
  const { data } = await adminApi.get<PaginatedResponse<CommissionableOrderRow>>(
    `/admin/businesses/${tenantId}/orders`,
    { params },
  );
  return { rows: data.data ?? [], pagination: data.pagination };
}

export async function postAdminGenerateReport(
  tenantId: string,
  body: { period_start: string; period_end: string },
) {
  const { data } = await adminApi.post<ApiResponse<{ report: CommissionReportRow }>>(
    `/admin/businesses/${tenantId}/generate-report`,
    body,
  );
  return data.data!.report;
}

export async function postAdminMarkBilled(tenantId: string, body: { period_start: string; period_end: string }) {
  const { data } = await adminApi.post<ApiResponse<{ updated_count: number }>>(
    `/admin/businesses/${tenantId}/mark-billed`,
    body,
  );
  return data.data!.updated_count;
}

export async function postAdminMarkPaid(tenantId: string, body: { period_start: string; period_end: string }) {
  const { data } = await adminApi.post<ApiResponse<{ updated_count: number }>>(
    `/admin/businesses/${tenantId}/mark-paid`,
    body,
  );
  return data.data!.updated_count;
}

export async function fetchAdminCommissionReportsAll(page: number, limit: number) {
  const { data } = await adminApi.get<PaginatedResponse<CommissionReportRow>>('/admin/commission-reports', {
    params: { page, limit },
  });
  return { rows: data.data ?? [], pagination: data.pagination };
}
