import pool from '../db/pool';
import type { ChannelType } from '../db/models/channel';
import type { Conversation } from '../db/models/conversation';
import type { Message } from '../db/models/message';
import type { DecodedMessageCursor } from '../utils/messageCursor';
import { encodeMessageCursor } from '../utils/messageCursor';

export interface ConversationListRow extends Conversation {
  contact_name: string;
  contact_avatar_url: string | null;
  channel_type: ChannelType;
  last_message_content: string | null;
  last_message_created_at: Date | null;
  /** Any outbound message exists (used with last_message_at for simplified unread UI). */
  has_outbound_message: boolean;
  /** Unread AI quality / off-topic alerts for this thread. */
  has_unread_ai_alert: boolean;
}

export interface ListConversationsParams {
  tenantId: string;
  page: number;
  limit: number;
  channel?: ChannelType;
  status?: string;
}

export async function listConversationsForTenant(
  params: ListConversationsParams,
): Promise<{ rows: ConversationListRow[]; total: number }> {
  const { tenantId, page, limit, channel, status } = params;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['c.tenant_id = $1'];
  const values: unknown[] = [tenantId];
  let p = 2;

  if (channel) {
    conditions.push(`ch.type = $${p}`);
    values.push(channel);
    p++;
  }
  if (status) {
    conditions.push(`c.status = $${p}`);
    values.push(status);
    p++;
  }

  const whereSql = conditions.join(' AND ');

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM conversations c
     INNER JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = c.tenant_id
     WHERE ${whereSql}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const listValues = [...values, limit, offset];
  const limitIdx = p;
  const offsetIdx = p + 1;

  const { rows } = await pool.query<ConversationListRow>(
    `SELECT
       c.id,
       c.tenant_id,
       c.contact_id,
       c.channel_id,
       c.status,
       c.last_message_at,
       c.human_override_until,
       c.ai_paused,
       c.fully_ai_handled,
       c.human_replied,
       c.created_at,
       c.updated_at,
       ct.name AS contact_name,
       ct.avatar_url AS contact_avatar_url,
       ch.type AS channel_type,
       lm.content AS last_message_content,
       lm.created_at AS last_message_created_at,
       EXISTS (
         SELECT 1 FROM messages mo
         WHERE mo.conversation_id = c.id AND mo.direction = 'outbound'
       ) AS has_outbound_message,
       EXISTS (
         SELECT 1 FROM ai_alerts aa
         WHERE aa.conversation_id = c.id
           AND aa.tenant_id = c.tenant_id
           AND aa.status = 'unread'
       ) AS has_unread_ai_alert
     FROM conversations c
     INNER JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
     INNER JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = c.tenant_id
     LEFT JOIN LATERAL (
       SELECT m.content, m.created_at
       FROM messages m
       WHERE m.conversation_id = c.id
       ORDER BY m.created_at DESC
       LIMIT 1
     ) lm ON true
     WHERE ${whereSql}
     ORDER BY c.last_message_at DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    listValues,
  );

  return { rows, total };
}

export interface OpenAIAlertSummary {
  id: string;
  reason: string;
  status: 'unread' | 'read';
}

export interface ConversationDetail extends Conversation {
  contact_name: string;
  contact_avatar_url: string | null;
  contact_external_id: string;
  channel_type: ChannelType;
  channel_name: string;
  /** Latest non-resolved quality alert (unread or read), if any. */
  open_ai_alert: OpenAIAlertSummary | null;
}

interface ConversationDetailQueryRow extends Conversation {
  contact_name: string;
  contact_avatar_url: string | null;
  contact_external_id: string;
  channel_type: ChannelType;
  channel_name: string;
  open_ai_alert_id: string | null;
  open_ai_alert_reason: string | null;
  open_ai_alert_status: string | null;
}

export async function findConversationDetailForTenant(
  conversationId: string,
  tenantId: string,
): Promise<ConversationDetail | null> {
  const { rows } = await pool.query<ConversationDetailQueryRow>(
    `SELECT
       c.id,
       c.tenant_id,
       c.contact_id,
       c.channel_id,
       c.status,
       c.last_message_at,
       c.human_override_until,
       c.ai_paused,
       c.fully_ai_handled,
       c.human_replied,
       c.created_at,
       c.updated_at,
       ct.name AS contact_name,
       ct.avatar_url AS contact_avatar_url,
       ct.external_id AS contact_external_id,
       ch.type AS channel_type,
       ch.name AS channel_name,
       oaa.id AS open_ai_alert_id,
       oaa.reason AS open_ai_alert_reason,
       oaa.status AS open_ai_alert_status
     FROM conversations c
     INNER JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
     INNER JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = c.tenant_id
     LEFT JOIN LATERAL (
       SELECT a.id, a.reason, a.status
       FROM ai_alerts a
       WHERE a.conversation_id = c.id
         AND a.tenant_id = c.tenant_id
         AND a.status IN ('unread', 'read')
       ORDER BY a.created_at DESC
       LIMIT 1
     ) oaa ON true
     WHERE c.id = $1 AND c.tenant_id = $2
     LIMIT 1`,
    [conversationId, tenantId],
  );
  const row = rows[0];
  if (!row) return null;

  const open_ai_alert: OpenAIAlertSummary | null =
    row.open_ai_alert_id &&
    row.open_ai_alert_reason &&
    (row.open_ai_alert_status === 'unread' || row.open_ai_alert_status === 'read')
      ? {
          id: row.open_ai_alert_id,
          reason: row.open_ai_alert_reason,
          status: row.open_ai_alert_status,
        }
      : null;

  return {
    id: row.id,
    tenant_id: row.tenant_id,
    contact_id: row.contact_id,
    channel_id: row.channel_id,
    status: row.status,
    last_message_at: row.last_message_at,
    human_override_until: row.human_override_until,
    ai_paused: row.ai_paused,
    fully_ai_handled: row.fully_ai_handled,
    human_replied: row.human_replied,
    created_at: row.created_at,
    updated_at: row.updated_at,
    contact_name: row.contact_name,
    contact_avatar_url: row.contact_avatar_url,
    contact_external_id: row.contact_external_id,
    channel_type: row.channel_type,
    channel_name: row.channel_name,
    open_ai_alert,
  };
}

export interface MessagesPageResult {
  messages: Message[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function listMessagesPageOldestFirst(params: {
  conversationId: string;
  tenantId: string;
  limit: number;
  cursor: DecodedMessageCursor | null;
}): Promise<MessagesPageResult> {
  const { conversationId, tenantId, limit, cursor } = params;
  const fetchLimit = Math.min(limit, 100) + 1;

  let cursorTime: Date | null = null;
  let cursorId: string | null = null;
  if (cursor?.kind === 'legacy_before') {
    cursorTime = cursor.createdAt;
  } else if (cursor?.kind === 'tuple') {
    cursorTime = cursor.createdAt;
    cursorId = cursor.id;
  }

  const { rows } = await pool.query<Message>(
    `SELECT *
     FROM messages
     WHERE conversation_id = $1
       AND tenant_id = $2
       AND (
         ($3::timestamptz IS NULL AND $4::uuid IS NULL)
         OR ($4::uuid IS NULL AND created_at < $3::timestamptz)
         OR (
           $4::uuid IS NOT NULL
           AND (created_at, id) < ($3::timestamptz, $4::uuid)
         )
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $5`,
    [conversationId, tenantId, cursorTime, cursorId, fetchLimit],
  );

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const messages = [...slice].reverse();

  const oldest = messages[0];
  const nextCursor =
    hasMore && oldest ? encodeMessageCursor({ created_at: oldest.created_at, id: oldest.id }) : null;

  return { messages, hasMore, nextCursor };
}

export async function setHumanOverride24h(conversationId: string, tenantId: string): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET human_override_until = NOW() + INTERVAL '24 hours',
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId],
  );
}

export async function countUnreadConversations(tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM conversations c
     WHERE c.tenant_id = $1
       AND c.last_message_at >= NOW() - INTERVAL '1 hour'
       AND NOT EXISTS (
         SELECT 1
         FROM messages m
         WHERE m.conversation_id = c.id
           AND m.direction = 'outbound'
       )`,
    [tenantId],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}
