import api from '@/lib/api';

export interface CreditsSummary {
  commission_this_month: number;
  use_case_fees_this_month: number;
  use_case_count_this_month: number;
  ai_orders_this_month: number;
  estimated_invoice: number;
  total_unpaid_commission: number;
  total_unpaid_use_case_fees: number;
}

export interface MonthlyBreakdownPoint {
  month_key: string;
  commission: number;
  use_case_fees: number;
  use_case_count: number;
}

export interface DailyUseCasePoint {
  day: string;
  count: number;
}

export interface AiUseCaseRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  contact_id: string;
  contact_name: string;
  status: 'completed' | 'voided';
  billing_status: 'unbilled' | 'billed' | 'paid';
  fee_amount: number | null;
  billing_period: string | null;
  resolved_at: string;
  created_at: string;
}

export interface AiOrderRow {
  id: string;
  conversation_id: string;
  contact_id: string;
  contact_name: string;
  product_name: string;
  total_price: number;
  commission_amount: number;
  commission_status: 'unpaid' | 'billed' | 'paid';
  status: string;
  created_at: string;
}

export interface BillingHistoryRow {
  id: string;
  period_start: string;
  period_end: string;
  total_orders: number;
  total_revenue: number;
  commission_amount: number;
  use_case_count: number;
  use_case_amount: number;
  total_amount: number;
  status: string;
  created_at: string;
}

export interface UseCaseTier {
  label: string;
  rate: number;
  lowerBound: number;
  upperBound: number;
}

export interface TierStatus {
  current_count: number;
  current_tier: UseCaseTier;
  projected_fee: number;
  next_tier: UseCaseTier | null;
  cases_to_next_tier: number | null;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string;
}

interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  message: string;
  pagination: Pagination;
}

export async function fetchCreditsSummary(): Promise<CreditsSummary> {
  const { data } = await api.get<ApiResponse<CreditsSummary>>('/credits/summary');
  return data.data;
}

export async function fetchMonthlyBreakdown(): Promise<MonthlyBreakdownPoint[]> {
  const { data } = await api.get<ApiResponse<{ series: MonthlyBreakdownPoint[] }>>(
    '/credits/monthly-breakdown',
  );
  return data.data.series;
}

export async function fetchDailyUseCaseVolume(): Promise<DailyUseCasePoint[]> {
  const { data } = await api.get<ApiResponse<{ series: DailyUseCasePoint[] }>>(
    '/credits/daily-volume',
  );
  return data.data.series;
}

export async function fetchAiUseCases(
  page = 1,
  limit = 20,
  period?: string,
): Promise<{ rows: AiUseCaseRow[]; pagination: Pagination }> {
  const { data } = await api.get<PaginatedResponse<AiUseCaseRow>>('/credits/use-cases', {
    params: { page, limit, ...(period ? { period } : {}) },
  });
  return { rows: data.data, pagination: data.pagination };
}

export async function fetchAllAiUseCases(): Promise<AiUseCaseRow[]> {
  const limit = 100;
  const first = await fetchAiUseCases(1, limit);
  const rows = [...first.rows];
  for (let page = 2; page <= first.pagination.totalPages; page++) {
    const next = await fetchAiUseCases(page, limit);
    rows.push(...next.rows);
  }
  return rows;
}

export async function fetchAiOrders(
  page = 1,
  limit = 15,
): Promise<{ rows: AiOrderRow[]; pagination: Pagination }> {
  const { data } = await api.get<PaginatedResponse<AiOrderRow>>('/credits/ai-orders', {
    params: { page, limit },
  });
  return { rows: data.data, pagination: data.pagination };
}

export async function fetchBillingHistory(
  page = 1,
  limit = 12,
): Promise<{ rows: BillingHistoryRow[]; pagination: Pagination }> {
  const { data } = await api.get<PaginatedResponse<BillingHistoryRow>>('/credits/billing-history', {
    params: { page, limit },
  });
  return { rows: data.data, pagination: data.pagination };
}

export async function fetchTierStatus(): Promise<TierStatus> {
  const { data } = await api.get<ApiResponse<TierStatus>>('/credits/tier-status');
  return data.data;
}
