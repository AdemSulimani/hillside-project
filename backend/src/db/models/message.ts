import pool from '../pool';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'document';
export type MessageSender = 'customer' | 'ai' | 'human';

export interface Message {
  id: string;
  tenant_id: string;
  conversation_id: string;
  external_message_id: string;
  direction: MessageDirection;
  type: MessageType;
  content: string | null;
  attachment_urls: string[];
  sent_by: MessageSender;
  ai_processed: boolean;
  created_at: Date;
}

export interface CreateMessageInput {
  tenant_id: string;
  conversation_id: string;
  external_message_id: string;
  direction: MessageDirection;
  type: MessageType;
  content?: string | null;
  attachment_urls?: string[];
  sent_by: MessageSender;
}

export async function findMessageByExternalMessageId(
  externalMessageId: string,
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    'SELECT * FROM messages WHERE external_message_id = $1 LIMIT 1',
    [externalMessageId],
  );
  return rows[0] ?? null;
}

export async function findMessagesByConversation(
  conversationId: string,
  limit = 10,
): Promise<Message[]> {
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [conversationId, limit],
  );
  return rows;
}

export async function createMessage(input: CreateMessageInput): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (
      tenant_id, conversation_id, external_message_id, direction, type, content, attachment_urls, sent_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
    RETURNING *`,
    [
      input.tenant_id,
      input.conversation_id,
      input.external_message_id,
      input.direction,
      input.type,
      input.content ?? null,
      JSON.stringify(input.attachment_urls ?? []),
      input.sent_by,
    ],
  );

  return rows[0];
}

export async function deleteMessageByIdForTenant(
  messageId: string,
  tenantId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'DELETE FROM messages WHERE id = $1 AND tenant_id = $2',
    [messageId, tenantId],
  );
  return (rowCount ?? 0) > 0;
}
