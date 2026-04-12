import type { PoolClient } from 'pg';
import pool from '../pool';
import type { ChannelType } from './channel';

export type AIAlertStatus = 'unread' | 'read' | 'resolved';

export interface AIAlert {
  id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  reason: string;
  status: AIAlertStatus;
  created_at: Date;
}

export interface CreateAIAlertInput {
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  reason: string;
}

export async function createAIAlert(
  input: CreateAIAlertInput,
  client: PoolClient | typeof pool = pool,
): Promise<AIAlert> {
  const { rows } = await client.query<AIAlert>(
    `INSERT INTO ai_alerts (tenant_id, conversation_id, message_id, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.tenant_id, input.conversation_id, input.message_id, input.reason],
  );
  return rows[0];
}

export interface AIAlertWithContext extends AIAlert {
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
  message_content: string | null;
  quality_score: number | null;
}

interface AIAlertListQueryRow extends AIAlert {
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
  message_content: string | null;
  quality_score: unknown;
}

export interface ListAIAlertsParams {
  tenantId: string;
  status?: AIAlertStatus;
  page: number;
  limit: number;
}

function mapAlertListRow(row: AIAlertListQueryRow): AIAlertWithContext {
  const qs = row.quality_score;
  let quality_score: number | null = null;
  if (qs != null) {
    const n = Number(qs);
    quality_score = Number.isFinite(n) ? n : null;
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    conversation_id: row.conversation_id,
    message_id: row.message_id,
    reason: row.reason,
    status: row.status,
    created_at: row.created_at,
    contact_name: row.contact_name,
    channel_type: row.channel_type,
    channel_name: row.channel_name,
    message_content: row.message_content,
    quality_score,
  };
}

export async function listAIAlertsForTenant(
  params: ListAIAlertsParams,
): Promise<{ rows: AIAlertWithContext[]; total: number }> {
  const { tenantId, status, page, limit } = params;
  const offset = (page - 1) * limit;
  const cap = Math.min(Math.max(1, limit), 100);

  const conditions: string[] = ['a.tenant_id = $1'];
  const values: unknown[] = [tenantId];
  let paramIdx = 2;

  if (status) {
    conditions.push(`a.status = $${paramIdx}`);
    values.push(status);
    paramIdx += 1;
  }

  const whereClause = conditions.join(' AND ');

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ai_alerts a WHERE ${whereClause}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<AIAlertListQueryRow>(
    `SELECT
       a.id,
       a.tenant_id,
       a.conversation_id,
       a.message_id,
       a.reason,
       a.status,
       a.created_at,
       ct.name AS contact_name,
       ch.type AS channel_type,
       ch.name AS channel_name,
       m.content AS message_content,
       m.quality_score
     FROM ai_alerts a
     INNER JOIN conversations c ON c.id = a.conversation_id AND c.tenant_id = a.tenant_id
     INNER JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = a.tenant_id
     INNER JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = a.tenant_id
     INNER JOIN messages m ON m.id = a.message_id AND m.tenant_id = a.tenant_id
     WHERE ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, cap, offset],
  );

  return { rows: rows.map(mapAlertListRow), total };
}

export async function markAllUnreadAIAlertsAsReadForTenant(tenantId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE ai_alerts
     SET status = 'read'
     WHERE tenant_id = $1 AND status = 'unread'`,
    [tenantId],
  );
  return rowCount ?? 0;
}

export async function countUnreadAIAlertsForTenant(tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM ai_alerts
     WHERE tenant_id = $1 AND status = 'unread'`,
    [tenantId],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export async function findAIAlertByIdForTenant(
  id: string,
  tenantId: string,
): Promise<AIAlert | null> {
  const { rows } = await pool.query<AIAlert>(
    'SELECT * FROM ai_alerts WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export async function updateAIAlertStatus(
  id: string,
  tenantId: string,
  status: AIAlertStatus,
): Promise<AIAlert | null> {
  const { rows } = await pool.query<AIAlert>(
    `UPDATE ai_alerts
     SET status = $3
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, status],
  );
  return rows[0] ?? null;
}
