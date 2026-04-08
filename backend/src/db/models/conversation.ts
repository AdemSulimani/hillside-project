import pool from '../pool';

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

export async function touchConversationLastMessageAt(id: string): Promise<void> {
  await pool.query(
    `UPDATE conversations
     SET last_message_at = now(), updated_at = now()
     WHERE id = $1`,
    [id],
  );
}
