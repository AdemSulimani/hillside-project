import pool from '../db/pool';
import type { ChannelType } from '../db/models/channel';
import type { Conversation } from '../db/models/conversation';
import type { Message } from '../db/models/message';

export interface ConversationListRow extends Conversation {
  contact_name: string;
  contact_avatar_url: string | null;
  channel_type: ChannelType;
  last_message_content: string | null;
  last_message_created_at: Date | null;
  /** Any outbound message exists (used with last_message_at for simplified unread UI). */
  has_outbound_message: boolean;
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
       ) AS has_outbound_message
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

export interface ConversationDetail extends Conversation {
  contact_name: string;
  contact_avatar_url: string | null;
  contact_external_id: string;
  channel_type: ChannelType;
  channel_name: string;
}

export async function findConversationDetailForTenant(
  conversationId: string,
  tenantId: string,
): Promise<ConversationDetail | null> {
  const { rows } = await pool.query<ConversationDetail>(
    `SELECT
       c.id,
       c.tenant_id,
       c.contact_id,
       c.channel_id,
       c.status,
       c.last_message_at,
       c.human_override_until,
       c.created_at,
       c.updated_at,
       ct.name AS contact_name,
       ct.avatar_url AS contact_avatar_url,
       ct.external_id AS contact_external_id,
       ch.type AS channel_type,
       ch.name AS channel_name
     FROM conversations c
     INNER JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
     INNER JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = c.tenant_id
     WHERE c.id = $1 AND c.tenant_id = $2
     LIMIT 1`,
    [conversationId, tenantId],
  );
  return rows[0] ?? null;
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
  before?: Date | null;
}): Promise<MessagesPageResult> {
  const { conversationId, tenantId, limit, before } = params;
  const fetchLimit = Math.min(limit, 100) + 1;

  const { rows } = await pool.query<Message>(
    `SELECT *
     FROM messages
     WHERE conversation_id = $1
       AND tenant_id = $2
       AND ($3::timestamptz IS NULL OR created_at < $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [conversationId, tenantId, before ?? null, fetchLimit],
  );

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const messages = [...slice].reverse();

  const nextCursor =
    hasMore && messages.length > 0 ? messages[0]!.created_at.toISOString() : null;

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
