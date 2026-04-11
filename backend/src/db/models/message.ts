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

export async function findMessageByIdForTenant(
  messageId: string,
  tenantId: string,
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    'SELECT * FROM messages WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [messageId, tenantId],
  );
  return rows[0] ?? null;
}

export async function listMessagesBeforeForConversation(
  conversationId: string,
  tenantId: string,
  beforeCreatedAt: Date,
  beforeMessageId: string,
  limit: number,
): Promise<Message[]> {
  const cap = Math.min(Math.max(1, limit), 500);
  const { rows } = await pool.query<Message>(
    `SELECT *
     FROM messages
     WHERE conversation_id = $1
       AND tenant_id = $2
       AND (
         created_at < $3::timestamptz
         OR (created_at = $3::timestamptz AND id < $4::uuid)
       )
     ORDER BY created_at ASC, id ASC
     LIMIT $5`,
    [conversationId, tenantId, beforeCreatedAt, beforeMessageId, cap],
  );
  return rows;
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

/**
 * Latest `limit` messages for the conversation, oldest-first (for AI / intent context).
 * Uses most recent window, not the earliest rows in the thread.
 */
export async function findMessagesByConversation(
  conversationId: string,
  limit = 10,
): Promise<Message[]> {
  const cap = Math.min(Math.max(1, limit), 500);
  const { rows } = await pool.query<Message>(
    `SELECT * FROM (
       SELECT *
       FROM messages
       WHERE conversation_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     ) sub
     ORDER BY created_at ASC, id ASC`,
    [conversationId, cap],
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

export async function updateMessageAttachmentUrls(
  messageId: string,
  attachmentUrls: string[],
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    `UPDATE messages SET attachment_urls = $1::jsonb WHERE id = $2 RETURNING *`,
    [JSON.stringify(attachmentUrls), messageId],
  );
  return rows[0] ?? null;
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

/** Most recent `limit` messages, oldest-first within the window (for transcripts). */
export async function listRecentMessagesChronologicalForConversation(
  conversationId: string,
  tenantId: string,
  limit: number,
): Promise<Message[]> {
  const cap = Math.min(Math.max(1, limit), 500);
  const { rows } = await pool.query<Message>(
    `SELECT * FROM (
       SELECT *
       FROM messages
       WHERE conversation_id = $1 AND tenant_id = $2
       ORDER BY created_at DESC
       LIMIT $3
     ) sub
     ORDER BY created_at ASC`,
    [conversationId, tenantId, cap],
  );
  return rows;
}
