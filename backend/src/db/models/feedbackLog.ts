import type { PoolClient } from 'pg';
import pool from '../pool';

export type FeedbackLogStatus = 'pending' | 'included_in_training';

export interface FeedbackLog {
  id: string;
  tenant_id: string;
  message_id: string;
  conversation_id: string;
  original_ai_response: string;
  corrected_response: string | null;
  reason: string | null;
  status: FeedbackLogStatus;
  created_at: Date;
}

export interface CreateFeedbackLogInput {
  tenant_id: string;
  message_id: string;
  conversation_id: string;
  original_ai_response: string;
  corrected_response?: string | null;
  reason?: string | null;
}

export interface FeedbackLogListFilters {
  tenantId: string;
  status?: FeedbackLogStatus;
  page?: number;
  limit?: number;
}

export async function createFeedbackLog(
  input: CreateFeedbackLogInput,
  client?: PoolClient,
): Promise<FeedbackLog> {
  const executor = client ?? pool;
  const { rows } = await executor.query<FeedbackLog>(
    `INSERT INTO feedback_logs (
      tenant_id, message_id, conversation_id,
      original_ai_response, corrected_response, reason
    ) VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *`,
    [
      input.tenant_id,
      input.message_id,
      input.conversation_id,
      input.original_ai_response,
      input.corrected_response ?? null,
      input.reason ?? null,
    ],
  );
  return rows[0];
}

export async function listFeedbackLogsForTenant(
  filters: FeedbackLogListFilters,
): Promise<{ logs: FeedbackLog[]; total: number }> {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['tenant_id = $1'];
  const values: unknown[] = [filters.tenantId];
  let paramIdx = 2;

  if (filters.status) {
    conditions.push(`status = $${paramIdx}`);
    values.push(filters.status);
    paramIdx++;
  }

  const where = conditions.join(' AND ');

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM feedback_logs WHERE ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const { rows } = await pool.query<FeedbackLog>(
    `SELECT * FROM feedback_logs
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset],
  );

  return { logs: rows, total };
}

export async function listTenantIdsEligibleForFinetuning(
  feedbackCountThreshold: number,
): Promise<string[]> {
  const { rows } = await pool.query<{ tenant_id: string }>(
    `SELECT DISTINCT fl.tenant_id
     FROM feedback_logs fl
     INNER JOIN ai_configs ac ON ac.tenant_id = fl.tenant_id
     WHERE fl.status = 'pending'
       AND ac.feedback_count >= $1
     ORDER BY fl.tenant_id`,
    [feedbackCountThreshold],
  );
  return rows.map((r) => r.tenant_id);
}

export async function listPendingFeedbackLogsForTenant(
  tenantId: string,
  client?: PoolClient,
): Promise<FeedbackLog[]> {
  const executor = client ?? pool;
  const { rows } = await executor.query<FeedbackLog>(
    `SELECT * FROM feedback_logs
     WHERE tenant_id = $1 AND status = 'pending'
     ORDER BY created_at ASC`,
    [tenantId],
  );
  return rows;
}

export async function updateFeedbackLogsStatus(
  tenantId: string,
  ids: string[],
  status: FeedbackLogStatus,
  client?: PoolClient,
): Promise<number> {
  if (ids.length === 0) return 0;
  const executor = client ?? pool;
  const { rowCount } = await executor.query(
    `UPDATE feedback_logs
     SET status = $3
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, ids, status],
  );
  return rowCount ?? 0;
}
