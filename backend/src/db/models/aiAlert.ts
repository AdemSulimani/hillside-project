import type { PoolClient } from 'pg';
import pool from '../pool';
import type { ChannelType } from './channel';

export type AIAlertStatus = 'unread' | 'read' | 'resolved';

export interface AIAlert {
  id: string;
  tenant_id: string;
  conversation_id: string | null;
  message_id: string | null;
  reason: string;
  status: AIAlertStatus;
  details: Record<string, unknown> | null;
  created_at: Date;
}

export interface CreateAIAlertInput {
  tenant_id: string;
  conversation_id: string | null;
  message_id: string | null;
  reason: string;
  /** Optional structured metadata (e.g. changed fields, previous/new values for order updates). */
  details?: Record<string, unknown> | null;
}

export async function createAIAlert(
  input: CreateAIAlertInput,
  client: PoolClient | typeof pool = pool,
): Promise<AIAlert> {
  const { rows } = await client.query<AIAlert>(
    `INSERT INTO ai_alerts (tenant_id, conversation_id, message_id, reason, details)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.tenant_id, input.conversation_id, input.message_id, input.reason, input.details ?? null],
  );
  return rows[0];
}

/**
 * P0-5 (RC-14): does this conversation have an OPEN (unread/read) SENSITIVE alert —
 * cancellation, refund, or post-purchase support? Used by the rate-limit auto-expiry
 * (part 3) and the invariant monitor (part 4) to avoid resuming/flagging a conversation a
 * human may be actively handling. Reasons are inlined in SQL to match the existing
 * escalation-tab query style (see `listEscalationAlertsForOrdersActionTab`).
 */
export async function hasOpenSensitiveAlertForConversation(
  conversationId: string,
  tenantId: string,
  client: PoolClient | typeof pool = pool,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ai_alerts
       WHERE conversation_id = $1
         AND tenant_id = $2
         AND status IN ('unread', 'read')
         AND reason IN (
           'cancellation_request',
           'refund_request',
           'post_purchase_support_request'
         )
     ) AS exists`,
    [conversationId, tenantId],
  );
  return rows[0]?.exists === true;
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
  details: Record<string, unknown> | null;
}

/** `open` = unread + read (not yet resolved). */
export type AIAlertListStatusFilter = AIAlertStatus | 'open';

export interface ListAIAlertsParams {
  tenantId: string;
  status?: AIAlertListStatusFilter;
  reason?: string;
  page: number;
  limit: number;
}

/** Open escalation alerts surfaced on Porositë → Veprim i nevojshëm (with order-based rows). */
export const ORDERS_ACTION_TAB_ALERT_REASONS = [
  'usage_question_unanswered',
  'product_question_unanswered',
  'post_purchase_support_request',
  'cancellation_request',
  'refund_request',
] as const;

export type OrdersActionTabAlertReason = (typeof ORDERS_ACTION_TAB_ALERT_REASONS)[number];

export interface OrdersActionTabAlertRow {
  id: string;
  conversation_id: string;
  message_id: string | null;
  reason: string;
  status: AIAlertStatus;
  created_at: Date;
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
  message_content: string | null;
}

export async function listEscalationAlertsForOrdersActionTab(
  tenantId: string,
): Promise<OrdersActionTabAlertRow[]> {
  const { rows } = await pool.query<AIAlertListQueryRow>(
    `SELECT
       a.id,
       a.tenant_id,
       a.conversation_id,
       a.message_id,
       a.reason,
       a.status,
       a.created_at,
       COALESCE(ct.name, '—') AS contact_name,
       COALESCE(ch.type, 'facebook') AS channel_type,
       COALESCE(ch.name, '—') AS channel_name,
       m.content AS message_content,
       m.quality_score
     FROM ai_alerts a
     LEFT JOIN conversations c ON c.id = a.conversation_id AND c.tenant_id = a.tenant_id
     LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = a.tenant_id
     LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = a.tenant_id
     LEFT JOIN messages m ON m.id = a.message_id AND m.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1
       AND a.conversation_id IS NOT NULL
       AND a.status IN ('unread', 'read')
       AND a.reason IN (
         'usage_question_unanswered',
         'product_question_unanswered',
         'post_purchase_support_request',
         'cancellation_request',
         'refund_request'
       )
     ORDER BY a.created_at DESC`,
    [tenantId],
  );

  return rows
    .filter((row) => row.conversation_id != null)
    .map((row) => ({
      id: row.id,
      conversation_id: row.conversation_id as string,
      message_id: row.message_id,
      reason: row.reason,
      status: row.status,
      created_at: row.created_at,
      contact_name: row.contact_name,
      channel_type: row.channel_type,
      channel_name: row.channel_name,
      message_content: row.message_content,
    }));
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
    details: row.details ?? null,
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
  const { tenantId, status, reason, page, limit } = params;
  const offset = (page - 1) * limit;
  const cap = Math.min(Math.max(1, limit), 100);

  const conditions: string[] = ['a.tenant_id = $1'];
  const values: unknown[] = [tenantId];
  let paramIdx = 2;

  if (status === 'open') {
    conditions.push(`a.status IN ('unread', 'read')`);
  } else if (status) {
    conditions.push(`a.status = $${paramIdx}`);
    values.push(status);
    paramIdx += 1;
  }

  if (reason) {
    conditions.push(`a.reason = $${paramIdx}`);
    values.push(reason);
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
       COALESCE(ct.name, '—') AS contact_name,
       COALESCE(ch.type, 'facebook') AS channel_type,
       COALESCE(ch.name, '—') AS channel_name,
       m.content AS message_content,
       m.quality_score
     FROM ai_alerts a
     LEFT JOIN conversations c ON c.id = a.conversation_id AND c.tenant_id = a.tenant_id
     LEFT JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = a.tenant_id
     LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = a.tenant_id
     LEFT JOIN messages m ON m.id = a.message_id AND m.tenant_id = a.tenant_id
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
