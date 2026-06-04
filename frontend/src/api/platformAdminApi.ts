import adminApi from '@/lib/adminApi';
import type { ApiResponse, PaginatedResponse, Tenant } from '@/types';

export interface AdminDashboardSummary {
  total_businesses: number;
  total_ai_completed_orders: number;
  total_commission_earned: number;
  total_unpaid_commission: number;
  total_paid_commission: number;
  total_ai_completed_use_cases: number;
  /** Completed use cases with billing_status = 'unbilled' (fee not yet calculated by billing job). */
  total_unbilled_use_cases: number;
  total_use_case_fees_earned: number;
  total_unpaid_use_case_fees: number;
}

export interface AdminBusinessRow {
  tenant_id: string;
  business_name: string;
  plan: string;
  total_orders: number;
  total_ai_completed_orders: number;
  total_commission_owed: number;
  aggregate_commission_status: 'unpaid' | 'billed' | 'paid' | 'clear';
  total_use_cases: number;
  total_use_case_fees_owed: number;
  aggregate_use_case_billing_status: 'unbilled' | 'billed' | 'paid' | 'clear';
}

export interface CommissionMonthPoint {
  month_key: string;
  commission: number;
  use_case_fees: number;
}

export interface AdminUseCaseRow {
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

export interface TenantUseCasePeriodStats {
  completed_use_cases: number;
  use_case_unbilled: number;
  use_case_billed: number;
  use_case_paid: number;
  use_case_fees_unbilled: number;
  use_case_fees_billed: number;
  use_case_fees_paid: number;
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

export async function patchAdminOrderCommissionStatus(
  orderId: string,
  body: { commission_status: CommissionableOrderRow['commission_status'] },
): Promise<void> {
  await adminApi.patch(`/admin/orders/${orderId}/commission-status`, body);
}

export async function fetchAdminBusinessUseCases(
  tenantId: string,
  page: number,
  limit: number,
) {
  const { data } = await adminApi.get<PaginatedResponse<AdminUseCaseRow>>(
    `/admin/businesses/${tenantId}/use-cases`,
    { params: { page, limit } },
  );
  return { rows: data.data ?? [], pagination: data.pagination };
}

export async function fetchAdminBusinessUseCasePeriodStats(
  tenantId: string,
  periodStart: string,
  periodEnd: string,
) {
  const { data } = await adminApi.get<ApiResponse<TenantUseCasePeriodStats>>(
    `/admin/businesses/${tenantId}/use-case-period-stats`,
    { params: { period_start: periodStart, period_end: periodEnd } },
  );
  return data.data!;
}

export async function patchAdminUseCaseBillingStatus(
  useCaseId: string,
  body: { billing_status: AdminUseCaseRow['billing_status'] },
): Promise<void> {
  await adminApi.patch(`/admin/use-cases/${useCaseId}/billing-status`, body);
}

export async function postAdminVoidUseCase(useCaseId: string): Promise<void> {
  await adminApi.post(`/admin/use-cases/${useCaseId}/void`);
}

export async function postAdminStampUseCaseFees(
  tenantId: string,
  body: { billing_period: string },
) {
  const { data } = await adminApi.post<
    ApiResponse<{ stamped_count: number; total_fee: number; fee_per_case: number }>
  >(`/admin/businesses/${tenantId}/use-cases/stamp-fees`, body);
  return data.data!;
}

export async function postAdminMarkUseCasesBilled(
  tenantId: string,
  body: { billing_period: string },
) {
  const { data } = await adminApi.post<ApiResponse<{ updated_count: number }>>(
    `/admin/businesses/${tenantId}/use-cases/mark-billed`,
    body,
  );
  return data.data!.updated_count;
}

export async function postAdminMarkUseCasesPaid(
  tenantId: string,
  body: { billing_period: string },
) {
  const { data } = await adminApi.post<ApiResponse<{ updated_count: number }>>(
    `/admin/businesses/${tenantId}/use-cases/mark-paid`,
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

export async function patchAdminCommissionReport(
  reportId: string,
  body: { status: CommissionReportRow['status'] },
) {
  const { data } = await adminApi.patch<ApiResponse<{ report: CommissionReportRow }>>(
    `/admin/commission-reports/${reportId}`,
    body,
  );
  return data.data!.report;
}

export async function deleteAdminCommissionReport(reportId: string) {
  await adminApi.delete(`/admin/commission-reports/${reportId}`);
}

// —— Admin AI (per business) ——

export interface AdminTenantAiConfig {
  id: string;
  tenant_id: string;
  tone: string;
  personality_description: string | null;
  restrictions: string[];
  platform_restrictions: string[];
  sales_strategy: string | null;
  objection_handling: string | null;
  qa_pairs: { question: string; answer: string }[];
  is_active: boolean;
  custom_model_id: string | null;
  feedback_count: number;
  created_at: string;
  updated_at: string;
}

export interface AdminTenantPromptBlockRow {
  id: string;
  tenant_id: string;
  prompt_block_id: string | null;
  block_key: string;
  enabled: boolean;
  content: string;
  sort_order: number;
  is_platform_locked: boolean | null;
  catalog_title: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdminAiConfigVersionRow {
  id: string;
  tenant_id: string;
  note: string | null;
  snapshot: Record<string, unknown>;
  created_by_email: string | null;
  created_at: string;
}

export async function fetchAdminTenantAiConfig(tenantId: string) {
  const { data } = await adminApi.get<ApiResponse<AdminTenantAiConfig>>(
    `/admin/businesses/${tenantId}/ai/config`,
  );
  return data.data!;
}

export async function fetchAdminTenantPromptBlocks(tenantId: string) {
  const { data } = await adminApi.get<ApiResponse<{ rows: AdminTenantPromptBlockRow[] }>>(
    `/admin/businesses/${tenantId}/ai/prompt-blocks`,
  );
  return data.data!.rows;
}

export async function putAdminTenantAiConfig(
  tenantId: string,
  body: Partial<{
    tone: string;
    personality_description: string | null;
    restrictions: string[];
    platform_restrictions: string[];
    sales_strategy: string | null;
    objection_handling: string | null;
    qa_pairs: { question: string; answer: string }[];
    is_active: boolean;
    custom_model_id: string | null;
  }>,
) {
  const { data } = await adminApi.put<ApiResponse<AdminTenantAiConfig>>(
    `/admin/businesses/${tenantId}/ai/config`,
    body,
  );
  return data.data!;
}

export async function patchAdminTenantPromptBlock(
  tenantId: string,
  blockRowId: string,
  body: { enabled?: boolean; content?: string; sort_order?: number },
) {
  const { data } = await adminApi.patch<ApiResponse<AdminTenantPromptBlockRow>>(
    `/admin/businesses/${tenantId}/ai/prompt-blocks/${blockRowId}`,
    body,
  );
  return data.data!;
}

export async function postAdminTenantPromptBlockReset(tenantId: string, blockRowId: string) {
  const { data } = await adminApi.post<ApiResponse<AdminTenantPromptBlockRow>>(
    `/admin/businesses/${tenantId}/ai/prompt-blocks/${blockRowId}/reset`,
  );
  return data.data!;
}

export async function postAdminTenantPromptBlockCustom(
  tenantId: string,
  body: { block_key: string; title: string; content: string; sort_order: number },
) {
  const { data } = await adminApi.post<ApiResponse<AdminTenantPromptBlockRow>>(
    `/admin/businesses/${tenantId}/ai/prompt-blocks`,
    body,
  );
  return data.data!;
}

export async function deleteAdminTenantPromptBlockCustom(tenantId: string, blockRowId: string) {
  await adminApi.delete(`/admin/businesses/${tenantId}/ai/prompt-blocks/${blockRowId}`);
}

export async function fetchAdminAiVersions(tenantId: string) {
  const { data } = await adminApi.get<ApiResponse<{ rows: AdminAiConfigVersionRow[] }>>(
    `/admin/businesses/${tenantId}/ai/versions`,
  );
  return data.data!.rows;
}

export async function postAdminRestoreAiVersion(tenantId: string, versionId: string) {
  const { data } = await adminApi.post<
    ApiResponse<{ restored_from: string }>
  >(`/admin/businesses/${tenantId}/ai/versions/${versionId}/restore`);
  return data.data!;
}

export async function postAdminTenantAiTest(
  tenantId: string,
  body: { testMessage: string; language?: 'sq' | 'en'; include_vision_block?: boolean },
) {
  const { data } = await adminApi.post<
    ApiResponse<{ reply: string; model_used: string }>
  >(`/admin/businesses/${tenantId}/ai/test`, body);
  return data.data!;
}

// —— Catalog block sync ——

export interface TenantCatalogSyncResult {
  added_count: number;
  added_block_keys: string[];
}

export interface BulkCatalogSyncTenantDetail {
  tenant_id: string;
  added_block_keys: string[];
}

export interface BulkCatalogSyncResult {
  tenants_updated: number;
  total_blocks_added: number;
  details: BulkCatalogSyncTenantDetail[];
}

/** Syncs missing platform catalog blocks into a single tenant. */
export async function postAdminSyncTenantCatalogBlocks(tenantId: string) {
  const { data } = await adminApi.post<ApiResponse<TenantCatalogSyncResult>>(
    `/admin/businesses/${tenantId}/ai/sync-catalog-blocks`,
  );
  return data.data!;
}

/**
 * Syncs missing platform catalog blocks across all tenants or a specific subset.
 * Pass an empty `tenantIds` array (or omit it) to target every business.
 */
export async function postAdminSyncAllCatalogBlocks(body?: { tenantIds?: string[] }) {
  const { data } = await adminApi.post<ApiResponse<BulkCatalogSyncResult>>(
    '/admin/ai/sync-catalog-blocks',
    body ?? {},
  );
  return data.data!;
}

// —— Platform catalog block management ——

export interface CatalogPromptBlock {
  id: string;
  key: string;
  title: string;
  description: string | null;
  default_content: string;
  category: 'guidelines' | 'vision';
  sort_order: number;
  is_platform_locked: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CatalogBlockSyncSummary {
  tenants_updated: number;
  total_blocks_added: number;
}

export async function fetchAdminCatalogBlocks() {
  const { data } = await adminApi.get<ApiResponse<{ rows: CatalogPromptBlock[] }>>(
    '/admin/ai/catalog-blocks',
  );
  return data.data!.rows;
}

export async function postAdminBackfillProductEmbeddings(
  tenantId: string,
): Promise<{ queued: number; product_ids: string[] }> {
  const { data } = await adminApi.post<
    ApiResponse<{ queued: number; product_ids: string[] }>
  >(`/admin/businesses/${tenantId}/products/backfill-embeddings`);
  return data.data!;
}

export async function postAdminReembedAllProducts(
  tenantId: string,
): Promise<{ queued: number; product_ids: string[] }> {
  const { data } = await adminApi.post<
    ApiResponse<{ queued: number; product_ids: string[] }>
  >(`/admin/businesses/${tenantId}/products/reembed-all`);
  return data.data!;
}

export async function postAdminBackfillProductImageFingerprints(
  tenantId: string,
): Promise<{ queued: number }> {
  const { data } = await adminApi.post<ApiResponse<{ queued: number }>>(
    `/admin/businesses/${tenantId}/products/backfill-image-fingerprints`,
  );
  return data.data!;
}

export async function postAdminCreateCatalogBlock(body: {
  key: string;
  title: string;
  description?: string | null;
  default_content: string;
  category: 'guidelines' | 'vision';
  sort_order: number;
  is_platform_locked: boolean;
  is_active: boolean;
  sync_to_existing: boolean;
}) {
  const { data } = await adminApi.post<
    ApiResponse<{ block: CatalogPromptBlock; sync: CatalogBlockSyncSummary | null }>
  >('/admin/ai/catalog-blocks', body);
  return data.data!;
}

export async function patchAdminCatalogBlock(
  blockId: string,
  body: Partial<{
    title: string;
    description: string | null;
    default_content: string;
    category: 'guidelines' | 'vision';
    sort_order: number;
    is_platform_locked: boolean;
    is_active: boolean;
    sync_to_existing: boolean;
  }>,
) {
  const { data } = await adminApi.patch<
    ApiResponse<{ block: CatalogPromptBlock; sync: CatalogBlockSyncSummary | null }>
  >(`/admin/ai/catalog-blocks/${blockId}`, body);
  return data.data!;
}

