import pool from '../pool';
import type { ChannelType } from './channel';

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  last_message_at: Date;
  human_override_until: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertConversationInput {
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status?: string;
  last_message_at?: Date;
}

export async function upsertConversation(input: UpsertConversationInput): Promise<Conversation> {
  const { rows } = await pool.query<Conversation>(
    `INSERT INTO conversations (tenant_id, contact_id, channel_id, status, last_message_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, now()))
     ON CONFLICT (tenant_id, contact_id, channel_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       last_message_at = GREATEST(conversations.last_message_at, EXCLUDED.last_message_at),
       updated_at = now()
     RETURNING *`,
    [
      input.tenant_id,
      input.contact_id,
      input.channel_id,
      input.status ?? 'open',
      input.last_message_at ?? null,
    ],
  );

  return rows[0];
}

export async function findConversationById(id: string): Promise<Conversation | null> {
  const { rows } = await pool.query<Conversation>(
    'SELECT * FROM conversations WHERE id = $1 LIMIT 1',
    [id],
  );
  return rows[0] ?? null;
}

export async function findConversationByIdForTenant(
  id: string,
  tenantId: string,
): Promise<Conversation | null> {
  const { rows } = await pool.query<Conversation>(
    'SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export async function updateConversationStatus(
  id: string,
  tenantId: string,
  status: string,
): Promise<Conversation | null> {
  const { rows } = await pool.query<Conversation>(
    `UPDATE conversations
     SET status = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, status],
  );
  return rows[0] ?? null;
}

export async function touchConversationLastMessageAt(id: string): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET last_message_at = now(), updated_at = now()
     WHERE id = $1`,
    [id],
  );
}

export interface ConversationWithChannel extends Conversation {
  channel_type: ChannelType;
  channel_name: string;
}

export async function listConversationsForContactForTenant(
  contactId: string,
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ rows: ConversationWithChannel[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM conversations c
     WHERE c.contact_id = $1 AND c.tenant_id = $2`,
    [contactId, tenantId],
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<ConversationWithChannel>(
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
       ch.type AS channel_type,
       ch.name AS channel_name
     FROM conversations c
     INNER JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = c.tenant_id
     WHERE c.contact_id = $1 AND c.tenant_id = $2
     ORDER BY c.last_message_at DESC
     LIMIT $3 OFFSET $4`,
    [contactId, tenantId, limit, offset],
  );

  return { rows, total };
}
