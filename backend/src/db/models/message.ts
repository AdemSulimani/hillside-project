import pool from '../pool';

export type MessageDirection = 'inbound' | 'outbound';
export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'document';
export type MessageSender = 'customer' | 'ai' | 'human';

export type MessageFlagReason =
  | 'off_topic'
  | 'unclear'
  | 'irrelevant'
  | 'misleading'
  | 'low_confidence';

/**
 * One stored snapshot of a message's prior content. Appended to `Message.edit_history` when an
 * edit lands; never mutated afterwards, so the row preserves the full audit trail.
 */
export interface MessageEditHistoryEntry {
  /** The content value as it stood before this edit replaced it. */
  content: string | null;
  /** The attachment URLs as they stood before this edit replaced them. */
  attachment_urls: string[];
  /** When the prior version was superseded (i.e. when the edit was applied). */
  edited_at: string;
  /** Edit counter delivered by the platform (Messenger `num_edit`); null when not provided. */
  num_edit?: number | null;
  /** Origin of the edit. Currently only Meta webhook deliveries. */
  source: 'platform';
}

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
  quality_score: number | null;
  flagged: boolean;
  flag_reason: MessageFlagReason | string | null;
  send_status: string | null;
  send_error: string | null;
  reply_to_message_id: string | null;
  reply_to_external_id: string | null;
  reply_to_content: string | null;
  reply_to_attachment_url: string | null;
  edited_at: Date | null;
  edit_count: number;
  /** Snapshot of `content` before the very first edit was applied. */
  original_content: string | null;
  edit_history: MessageEditHistoryEntry[];
  created_at: Date;
}

function coerceEditHistory(raw: unknown): MessageEditHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageEditHistoryEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    const editedAt = typeof o.edited_at === 'string' ? o.edited_at : null;
    if (!editedAt) continue;
    const content = typeof o.content === 'string' ? o.content : null;
    const attachment_urls = Array.isArray(o.attachment_urls)
      ? o.attachment_urls.filter((u): u is string => typeof u === 'string' && u.length > 0)
      : [];
    const numEditRaw = o.num_edit;
    const num_edit =
      typeof numEditRaw === 'number' && Number.isFinite(numEditRaw)
        ? numEditRaw
        : numEditRaw == null
          ? null
          : null;
    out.push({
      content,
      attachment_urls,
      edited_at: editedAt,
      num_edit,
      source: 'platform',
    });
  }
  return out;
}

export function mapMessageRow(row: Message): Message {
  const r = row as Message & {
    quality_score?: unknown;
    send_status?: unknown;
    send_error?: unknown;
    reply_to_message_id?: unknown;
    reply_to_external_id?: unknown;
    reply_to_content?: unknown;
    reply_to_attachment_url?: unknown;
    edited_at?: unknown;
    edit_count?: unknown;
    original_content?: unknown;
    edit_history?: unknown;
  };
  let quality_score: number | null = null;
  const rawQs = r.quality_score;
  if (rawQs != null) {
    const n = Number(rawQs);
    quality_score = Number.isFinite(n) ? n : null;
  }
  let edited_at: Date | null = null;
  if (r.edited_at instanceof Date) {
    edited_at = r.edited_at;
  } else if (typeof r.edited_at === 'string' && r.edited_at) {
    const d = new Date(r.edited_at);
    edited_at = Number.isNaN(d.getTime()) ? null : d;
  }
  const editCountRaw = r.edit_count;
  const edit_count =
    typeof editCountRaw === 'number' && Number.isFinite(editCountRaw)
      ? editCountRaw
      : editCountRaw != null
        ? Number(editCountRaw) || 0
        : 0;
  return {
    ...row,
    quality_score,
    flagged: Boolean(r.flagged),
    flag_reason: r.flag_reason ?? null,
    send_status: r.send_status != null && r.send_status !== '' ? String(r.send_status) : null,
    send_error: r.send_error != null && r.send_error !== '' ? String(r.send_error) : null,
    reply_to_message_id: r.reply_to_message_id != null ? String(r.reply_to_message_id) : null,
    reply_to_external_id:
      r.reply_to_external_id != null && r.reply_to_external_id !== ''
        ? String(r.reply_to_external_id)
        : null,
    reply_to_content: r.reply_to_content != null ? String(r.reply_to_content) : null,
    reply_to_attachment_url:
      r.reply_to_attachment_url != null && r.reply_to_attachment_url !== ''
        ? String(r.reply_to_attachment_url)
        : null,
    edited_at,
    edit_count,
    original_content: typeof r.original_content === 'string' ? r.original_content : null,
    edit_history: coerceEditHistory(r.edit_history),
  };
}

/** Snapshot text + first media URL from a stored message for reply_to_* columns. */
export function buildReplySnapshotFromMessage(msg: Message): {
  reply_to_content: string | null;
  reply_to_attachment_url: string | null;
} {
  const urls = Array.isArray(msg.attachment_urls) ? msg.attachment_urls : [];
  const firstUrl = urls.find((u) => typeof u === 'string' && u.length > 0) ?? null;
  const text = (msg.content ?? '').trim();
  let reply_to_content: string | null = text || null;
  if (!reply_to_content && firstUrl) {
    reply_to_content = `[${msg.type} attachment]`;
  }
  if (!reply_to_content) {
    reply_to_content = '[Message]';
  }
  const mediaTypes: MessageType[] = ['image', 'video', 'document', 'audio'];
  const reply_to_attachment_url =
    firstUrl && mediaTypes.includes(msg.type) ? firstUrl : null;
  return { reply_to_content, reply_to_attachment_url };
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
  quality_score?: number | null;
  flagged?: boolean;
  flag_reason?: string | null;
}

export async function findMessageByIdForTenant(
  messageId: string,
  tenantId: string,
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    'SELECT * FROM messages WHERE id = $1 AND tenant_id = $2 LIMIT 1',
    [messageId, tenantId],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
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
  return rows.map(mapMessageRow);
}

export async function findMessageByExternalMessageId(
  externalMessageId: string,
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    'SELECT * FROM messages WHERE external_message_id = $1 LIMIT 1',
    [externalMessageId],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
}

export async function findMessageByExternalMessageIdForTenant(
  tenantId: string,
  externalMessageId: string,
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    'SELECT * FROM messages WHERE tenant_id = $1 AND external_message_id = $2 LIMIT 1',
    [tenantId, externalMessageId],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
}

/** Lightweight id-only lookup for inbound deduplication. */
export async function findMessageIdByExternalMessageId(
  externalMessageId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM messages WHERE external_message_id = $1 LIMIT 1',
    [externalMessageId],
  );
  return rows[0]?.id ?? null;
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
  return rows.map(mapMessageRow);
}

export async function createMessage(input: CreateMessageInput): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (
      tenant_id, conversation_id, external_message_id, direction, type, content, attachment_urls, sent_by,
      quality_score, flagged, flag_reason
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, COALESCE($10, false), $11)
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
      input.quality_score ?? null,
      input.flagged ?? false,
      input.flag_reason ?? null,
    ],
  );

  return mapMessageRow(rows[0]);
}

export async function updateMessageReplyResolved(
  messageId: string,
  tenantId: string,
  params: {
    reply_to_message_id: string;
    reply_to_content: string | null;
    reply_to_attachment_url: string | null;
  },
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    `UPDATE messages
     SET reply_to_message_id = $1,
         reply_to_content = $2,
         reply_to_attachment_url = $3
     WHERE id = $4 AND tenant_id = $5
     RETURNING *`,
    [
      params.reply_to_message_id,
      params.reply_to_content,
      params.reply_to_attachment_url,
      messageId,
      tenantId,
    ],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
}

export async function updateMessageReplyExternalOnly(
  messageId: string,
  tenantId: string,
  reply_to_external_id: string,
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    `UPDATE messages
     SET reply_to_external_id = $1
     WHERE id = $2 AND tenant_id = $3
     RETURNING *`,
    [reply_to_external_id, messageId, tenantId],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
}

const SEND_ERROR_MAX_LEN = 2000;

export async function updateMessageSendFailure(
  messageId: string,
  tenantId: string,
  sendStatus: string,
  sendError: string,
): Promise<Message | null> {
  const trimmedError =
    sendError.length > SEND_ERROR_MAX_LEN
      ? sendError.slice(0, SEND_ERROR_MAX_LEN)
      : sendError;
  const { rows } = await pool.query<Message>(
    `UPDATE messages
     SET send_status = $1, send_error = $2
     WHERE id = $3 AND tenant_id = $4
     RETURNING *`,
    [sendStatus, trimmedError, messageId, tenantId],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
}

export async function updateMessageAttachmentUrls(
  messageId: string,
  attachmentUrls: string[],
): Promise<Message | null> {
  const { rows } = await pool.query<Message>(
    `UPDATE messages SET attachment_urls = $1::jsonb WHERE id = $2 RETURNING *`,
    [JSON.stringify(attachmentUrls), messageId],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
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

export interface ApplyMessageEditInput {
  /** UUID of the row to edit. */
  messageId: string;
  /** Tenant scope; we never cross-tenant edit. */
  tenantId: string;
  /** New text content from the platform. */
  newContent: string | null;
  /** New attachment URLs from the platform; pass through unchanged when the platform doesn't redeliver. */
  newAttachmentUrls?: string[];
  /** Wall-clock time the edit was applied (defaults to NOW()). */
  editedAt?: Date;
  /** Optional platform-supplied edit counter (Messenger `num_edit`). */
  numEdit?: number | null;
}

/**
 * Applies a platform edit atomically:
 * - Pushes the *current* (pre-edit) content + attachments onto `edit_history`.
 * - Snapshots `original_content` on the very first edit so we never lose the original text.
 * - Replaces `content`, `attachment_urls`, sets `edited_at = NOW()`, increments `edit_count`.
 *
 * Idempotency: if the new content equals the current content AND no new attachments,
 * we skip the update so duplicate webhook deliveries don't pollute history.
 */
export async function applyMessageEdit(
  input: ApplyMessageEditInput,
): Promise<{ message: Message; changed: boolean } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<Message>(
      'SELECT * FROM messages WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [input.messageId, input.tenantId],
    );
    const row = current.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    const mapped = mapMessageRow(row);

    const currentContent = mapped.content ?? null;
    const currentAttachments = Array.isArray(mapped.attachment_urls) ? mapped.attachment_urls : [];
    const newAttachments = input.newAttachmentUrls ?? currentAttachments;
    const sameContent = (currentContent ?? '') === (input.newContent ?? '');
    const sameAttachments =
      currentAttachments.length === newAttachments.length &&
      currentAttachments.every((u, i) => u === newAttachments[i]);
    if (sameContent && sameAttachments) {
      await client.query('ROLLBACK');
      return { message: mapped, changed: false };
    }

    const editedAt = input.editedAt ?? new Date();
    const historyEntry: MessageEditHistoryEntry = {
      content: currentContent,
      attachment_urls: currentAttachments,
      edited_at: editedAt.toISOString(),
      num_edit: input.numEdit ?? null,
      source: 'platform',
    };

    const { rows } = await client.query<Message>(
      `UPDATE messages
       SET content = $1,
           attachment_urls = $2::jsonb,
           edited_at = $3,
           edit_count = edit_count + 1,
           original_content = COALESCE(original_content, $4),
           edit_history = COALESCE(edit_history, '[]'::jsonb) || $5::jsonb
       WHERE id = $6 AND tenant_id = $7
       RETURNING *`,
      [
        input.newContent,
        JSON.stringify(newAttachments),
        editedAt,
        currentContent,
        JSON.stringify([historyEntry]),
        input.messageId,
        input.tenantId,
      ],
    );
    await client.query('COMMIT');
    const updated = rows[0];
    return updated ? { message: mapMessageRow(updated), changed: true } : null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * True when there is at least one outbound message (AI or human) in the same conversation
 * created strictly after the given timestamp. Used by the edit handler to decide whether the
 * AI/agent has already responded to a now-stale customer message and therefore needs another pass.
 */
export async function existsOutboundAfter(
  conversationId: string,
  tenantId: string,
  afterCreatedAt: Date,
): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM messages
       WHERE conversation_id = $1
         AND tenant_id = $2
         AND direction = 'outbound'
         AND created_at > $3
     ) AS exists`,
    [conversationId, tenantId, afterCreatedAt],
  );
  return rows[0]?.exists === true;
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
  return rows.map(mapMessageRow);
}
