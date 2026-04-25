import type { PoolClient } from 'pg';
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
  ai_paused: boolean;
  fully_ai_handled: boolean;
  human_replied: boolean;
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

export async function setConversationAiPaused(
  id: string,
  tenantId: string,
  aiPaused: boolean,
  client: PoolClient | typeof pool = pool,
): Promise<Conversation | null> {
  const { rows } = await client.query<Conversation>(
    `UPDATE conversations
     SET ai_paused = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, aiPaused],
  );
  return rows[0] ?? null;
}

export async function markConversationHumanReplied(
  conversationId: string,
  tenantId: string,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations
     SET human_replied = true, updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId],
  );
}

export async function setConversationHumanReplied(
  conversationId: string,
  tenantId: string,
  humanReplied: boolean,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations
     SET human_replied = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId, humanReplied],
  );
}

export async function setConversationFullyAiHandled(
  conversationId: string,
  tenantId: string,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations
     SET fully_ai_handled = true, updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [conversationId, tenantId],
  );
}

export async function toggleAiPaused(
  id: string,
  tenantId: string,
): Promise<Conversation | null> {
  const { rows } = await pool.query<Conversation>(
    `UPDATE conversations
     SET
       ai_paused = NOT ai_paused,
       human_override_until = CASE
         WHEN ai_paused THEN NULL
         ELSE human_override_until
       END,
       updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export type PausedConversationForControl = Conversation & {
  contact_name: string;
  channel_name: string;
  channel_type: ChannelType;
};

export async function findPausedConversationsByTenant(
  tenantId: string,
): Promise<PausedConversationForControl[]> {
  const { rows } = await pool.query<PausedConversationForControl>(
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
       ch.name AS channel_name,
       ch.type AS channel_type
     FROM conversations c
     INNER JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
     INNER JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = c.tenant_id
     WHERE c.tenant_id = $1 AND c.ai_paused = true
     ORDER BY c.updated_at DESC`,
    [tenantId],
  );
  return rows;
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
       c.ai_paused,
       c.fully_ai_handled,
       c.human_replied,
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
