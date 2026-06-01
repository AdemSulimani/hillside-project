import type { PoolClient } from 'pg';
import pool from '../pool';

export type AiUseCaseStatus = 'completed' | 'voided';
export type AiUseCaseBillingStatus = 'unbilled' | 'billed' | 'paid';

export interface AiUseCase {
  id: string;
  tenant_id: string;
  conversation_id: string;
  contact_id: string;
  status: AiUseCaseStatus;
  billing_status: AiUseCaseBillingStatus;
  fee_amount: number | null;
  billing_period: string | null;
  resolved_at: Date;
  created_at: Date;
  updated_at: Date;
}

type AiUseCaseRow = Omit<AiUseCase, 'fee_amount'> & {
  fee_amount: string | number | null;
};

function rowToUseCase(row: AiUseCaseRow): AiUseCase {
  return {
    ...row,
    fee_amount: row.fee_amount != null ? Number(row.fee_amount) : null,
  };
}

export interface CreateAiUseCaseInput {
  tenant_id: string;
  conversation_id: string;
  contact_id: string;
  resolved_at?: Date;
}

/**
 * Inserts a completed AI use case row.
 * Uses ON CONFLICT DO NOTHING so the job can be safely retried without duplicates.
 * Returns null if the conversation already has a use case row (idempotent).
 */
export async function createAiUseCase(
  input: CreateAiUseCaseInput,
  client: PoolClient | typeof pool = pool,
): Promise<AiUseCase | null> {
  const { rows } = await client.query<AiUseCaseRow>(
    `INSERT INTO ai_use_cases (tenant_id, conversation_id, contact_id, resolved_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (conversation_id) DO NOTHING
     RETURNING *`,
    [input.tenant_id, input.conversation_id, input.contact_id, input.resolved_at ?? new Date()],
  );
  return rows[0] ? rowToUseCase(rows[0]) : null;
}

/**
 * Returns the use case row for a conversation, or null if none exists.
 */
export async function findAiUseCaseByConversation(
  conversationId: string,
  client: PoolClient | typeof pool = pool,
): Promise<AiUseCase | null> {
  const { rows } = await client.query<AiUseCaseRow>(
    'SELECT * FROM ai_use_cases WHERE conversation_id = $1 LIMIT 1',
    [conversationId],
  );
  return rows[0] ? rowToUseCase(rows[0]) : null;
}

/**
 * Voids an unbilled use case when the conversation's order is confirmed.
 * Only operates on rows with billing_status = 'unbilled' to protect already-billed rows.
 */
export async function voidAiUseCaseForConversation(
  conversationId: string,
  client: PoolClient | typeof pool = pool,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE ai_use_cases
     SET status = 'voided', updated_at = now()
     WHERE conversation_id = $1
       AND status = 'completed'
       AND billing_status = 'unbilled'`,
    [conversationId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface AiUseCaseListRow extends AiUseCase {
  contact_name: string;
}

/**
 * Returns a paginated list of completed use cases for a tenant, newest first.
 * Optionally filtered to a billing period (e.g. '2026-05').
 */
export async function listAiUseCasesForTenant(
  tenantId: string,
  page: number,
  limit: number,
  billingPeriod?: string | null,
): Promise<{ rows: AiUseCaseListRow[]; total: number }> {
  const offset = (page - 1) * limit;
  const periodFilter = billingPeriod ? ' AND uc.billing_period = $2' : '';
  const baseParams: unknown[] = billingPeriod ? [tenantId, billingPeriod] : [tenantId];

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM ai_use_cases uc
     WHERE uc.tenant_id = $1
       AND uc.status = 'completed'${periodFilter}`,
    baseParams,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const limitIdx = billingPeriod ? 3 : 2;
  const offsetIdx = billingPeriod ? 4 : 3;

  const { rows } = await pool.query<AiUseCaseRow & { contact_name: string }>(
    `SELECT uc.*, COALESCE(ct.name, 'Unknown') AS contact_name
     FROM ai_use_cases uc
     LEFT JOIN contacts ct ON ct.id = uc.contact_id
     WHERE uc.tenant_id = $1
       AND uc.status = 'completed'${periodFilter}
     ORDER BY uc.resolved_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    [...baseParams, limit, offset],
  );

  return {
    rows: rows.map((r) => {
      const { contact_name, ...uc } = r;
      return { ...rowToUseCase(uc), contact_name };
    }),
    total,
  };
}

/**
 * Counts completed use cases for a tenant within the given resolved_at range.
 * Used by the billing snapshot job and the tier-status API.
 */
export async function countAiUseCasesForTenantInPeriod(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND status = 'completed'
       AND resolved_at >= $2
       AND resolved_at < $3`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Returns all unbilled, completed use case IDs for a tenant resolved within a date range.
 * Used by the month-end snapshot job to lock and update rows atomically.
 */
export async function findUnbilledUseCaseIdsForTenantInPeriod(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
  client: PoolClient,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND status = 'completed'
       AND billing_status = 'unbilled'
       AND resolved_at >= $2
       AND resolved_at < $3
     ORDER BY resolved_at ASC
     FOR UPDATE`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  return rows.map((r) => r.id);
}

/**
 * Locks and returns ALL completed use case IDs for a tenant resolved within a date range,
 * regardless of billing_status or whether fee_amount is already set.
 * Used by the admin manual fee-stamp action to allow recalculation.
 */
export async function findAllCompletedUseCaseIdsForTenantInPeriod(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
  client: PoolClient,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id
     FROM ai_use_cases
     WHERE tenant_id = $1
       AND status = 'completed'
       AND resolved_at >= $2
       AND resolved_at < $3
     ORDER BY resolved_at ASC
     FOR UPDATE`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  return rows.map((r) => r.id);
}

/**
 * Stamps a billing period and per-case fee on a batch of use case rows within a transaction.
 */
export async function stampBillingPeriodOnUseCases(
  ids: string[],
  billingPeriod: string,
  feeAmountPerCase: number,
  client: PoolClient,
): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE ai_use_cases
     SET billing_period = $1,
         fee_amount = $2,
         updated_at = now()
     WHERE id = ANY($3::uuid[])`,
    [billingPeriod, feeAmountPerCase, ids],
  );
}

/**
 * Marks a batch of use case rows as billed within a transaction.
 */
export async function markUseCasesBilledInPeriod(
  tenantId: string,
  billingPeriod: string,
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  const result = await client.query(
    `UPDATE ai_use_cases
     SET billing_status = 'billed', updated_at = now()
     WHERE tenant_id = $1
       AND billing_period = $2
       AND status = 'completed'
       AND billing_status = 'unbilled'`,
    [tenantId, billingPeriod],
  );
  return result.rowCount ?? 0;
}

/**
 * Marks a batch of use case rows as paid within a transaction.
 */
export async function markUseCasesPaidInPeriod(
  tenantId: string,
  billingPeriod: string,
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  const result = await client.query(
    `UPDATE ai_use_cases
     SET billing_status = 'paid', updated_at = now()
     WHERE tenant_id = $1
       AND billing_period = $2
       AND status = 'completed'
       AND billing_status = 'billed'`,
    [tenantId, billingPeriod],
  );
  return result.rowCount ?? 0;
}

/**
 * Updates the billing_status of a single use case row (admin override).
 */
export async function updateAiUseCaseBillingStatus(
  id: string,
  billingStatus: AiUseCaseBillingStatus,
): Promise<AiUseCase | null> {
  const { rows } = await pool.query<AiUseCaseRow>(
    `UPDATE ai_use_cases
     SET billing_status = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, billingStatus],
  );
  return rows[0] ? rowToUseCase(rows[0]) : null;
}

/**
 * Admin void of a use case (only before it's billed).
 */
export async function adminVoidAiUseCase(id: string): Promise<AiUseCase | null> {
  const { rows } = await pool.query<AiUseCaseRow>(
    `UPDATE ai_use_cases
     SET status = 'voided', updated_at = now()
     WHERE id = $1
       AND billing_status = 'unbilled'
     RETURNING *`,
    [id],
  );
  return rows[0] ? rowToUseCase(rows[0]) : null;
}

export interface AdminAiUseCaseListRow extends AiUseCase {
  contact_name: string;
}

/**
 * Admin paginated list of use cases for a specific tenant.
 */
export async function listAiUseCasesForAdmin(
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ rows: AdminAiUseCaseListRow[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ai_use_cases WHERE tenant_id = $1`,
    [tenantId],
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<AiUseCaseRow & { contact_name: string }>(
    `SELECT uc.*, COALESCE(ct.name, 'Unknown') AS contact_name
     FROM ai_use_cases uc
     LEFT JOIN contacts ct ON ct.id = uc.contact_id
     WHERE uc.tenant_id = $1
     ORDER BY uc.resolved_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );

  return {
    rows: rows.map((r) => {
      const { contact_name, ...uc } = r;
      return { ...rowToUseCase(uc), contact_name };
    }),
    total,
  };
}
