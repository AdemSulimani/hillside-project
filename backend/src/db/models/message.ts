import type { PoolClient } from 'pg';
import pool from '../pool';
import { isStaleMessageEdit } from '../../services/webhookDelivery';

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
  /**
   * IDs of the catalog products the AI identified/recommended when generating this
   * message. Persisted on outbound AI messages so follow-up turns ("what are the
   * prices?", "what flavors?") can deterministically reuse the previously resolved
   * products instead of re-running a fragile text lookup. Empty for inbound messages
   * and for AI replies that did not surface any product.
   */
  product_ids: string[];
  created_at: Date;
}

function coerceProductIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
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
    product_ids?: unknown;
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
    product_ids: coerceProductIds(r.product_ids),
  };
}

/**
 * Returns the product IDs the AI most recently identified in the conversation.
 *
 * Scans the supplied message window from newest to oldest and returns the
 * `product_ids` of the most recent AI message that surfaced any products. This is
 * the deterministic source of "the products we just discussed" used to answer
 * follow-up questions (price, brand, flavor, stock, etc.) without re-running
 * retrieval. AI messages that surfaced no products (escalations, clarifying
 * questions) are skipped so the last real recommendation is not forgotten.
 *
 * `messages` is expected oldest-first (as returned by `findMessagesByConversation`).
 */
export function collectRecentlyDiscussedProductIds(messages: Message[]): string[] {
  return collectRecentlyDiscussedProductContext(messages).ids;
}

/**
 * Like {@link collectRecentlyDiscussedProductIds}, but also returns the TEXT of the AI
 * message the ids came from. `product_ids` persists the whole fused retrieval pool
 * (10–25 rows), while the customer has only ever SEEN the products the reply wrote out —
 * callers that scope follow-up behaviour to "what we discussed" need the reply text to
 * tell those apart (live bug: "A ka najfar shije a jo" after "Po, kemi BSN Creatine
 * 216gr…" ran the gap machinery over all 10 pooled creatines and escalated "shija" for
 * products the customer never saw).
 */
export function collectRecentlyDiscussedProductContext(messages: Message[]): {
  ids: string[];
  sourceText: string | null;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.sent_by !== 'ai') continue;
    const ids = Array.isArray(msg.product_ids) ? msg.product_ids : [];
    if (ids.length > 0) {
      const text = (msg.content ?? '').trim();
      return { ids: [...ids], sourceText: text.length > 0 ? text : null };
    }
  }
  return { ids: [], sourceText: null };
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
  /** Catalog product IDs the AI identified/recommended for this message. */
  product_ids?: string[];
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
 * Tenant-scoped id-only lookup for inbound deduplication (P1-1 / RC-20). Reads against the
 * scoped `idx_messages_tenant_external` index rather than the global one, so two tenants can
 * legitimately carry the same channel `external_message_id` (closes the C-114 cross-tenant
 * dedupe leak). Used when `MESSAGES_SCOPED_UNIQUE_READ` is on; the global variant above is the
 * legacy default.
 */
export async function findMessageIdByTenantAndExternalMessageId(
  tenantId: string,
  externalMessageId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM messages WHERE tenant_id = $1 AND external_message_id = $2 LIMIT 1',
    [tenantId, externalMessageId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Latest `limit` messages for the conversation, oldest-first (for AI / intent context).
 * Uses most recent window, not the earliest rows in the thread.
 *
 * P1-7 (SEC-3 / C-116): pass `tenantId` to additionally scope by tenant so a mis-resolved tenant can
 * never read another tenant's messages. Optional/additive — the filter is a no-op in normal operation
 * (the conversation's messages already belong to that tenant), so existing callers are unaffected.
 */
export async function findMessagesByConversation(
  conversationId: string,
  limit = 10,
  tenantId?: string,
): Promise<Message[]> {
  const cap = Math.min(Math.max(1, limit), 500);
  const params: unknown[] = [conversationId, cap];
  let tenantClause = '';
  if (tenantId) {
    params.push(tenantId);
    tenantClause = ` AND tenant_id = $${params.length}`;
  }
  const { rows } = await pool.query<Message>(
    `SELECT * FROM (
       SELECT *
       FROM messages
       WHERE conversation_id = $1${tenantClause}
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     ) sub
     ORDER BY created_at ASC, id ASC`,
    params,
  );
  return rows.map(mapMessageRow);
}

export async function createMessage(input: CreateMessageInput): Promise<Message> {
  const { rows } = await pool.query<Message>(
    `INSERT INTO messages (
      tenant_id, conversation_id, external_message_id, direction, type, content, attachment_urls, sent_by,
      quality_score, flagged, flag_reason, product_ids
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, COALESCE($10, false), $11, $12::jsonb)
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
      JSON.stringify(coerceProductIds(input.product_ids)),
    ],
  );

  return mapMessageRow(rows[0]);
}

/**
 * Transactional, idempotent message insert (P1-1 / RC-20 & RC-21). Runs on a caller-supplied
 * client so the insert can be atomic with an outbox row (inbound) or with the staging flip +
 * side-effect outbox rows (outbound). `ON CONFLICT (tenant_id, external_message_id) DO NOTHING`
 * makes a BullMQ retry no-op instead of dead-lettering on the unique constraint; when the
 * conflict fires the existing row is SELECTed back so the caller always gets the delivered row.
 *
 * Requires the scoped `idx_messages_tenant_external` index (migration 071) as the conflict
 * target — behaviour is only exercised behind the P1-1 flags, which land after 071.
 */
export async function createMessageTx(
  client: PoolClient,
  input: CreateMessageInput & { send_status?: string | null; send_error?: string | null },
): Promise<Message> {
  const values = [
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
    JSON.stringify(coerceProductIds(input.product_ids)),
    input.send_status ?? null,
    input.send_error ?? null,
  ];
  const inserted = await client.query<Message>(
    `INSERT INTO messages (
      tenant_id, conversation_id, external_message_id, direction, type, content, attachment_urls, sent_by,
      quality_score, flagged, flag_reason, product_ids, send_status, send_error
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, COALESCE($10, false), $11, $12::jsonb, $13, $14)
    ON CONFLICT (tenant_id, external_message_id) DO NOTHING
    RETURNING *`,
    values,
  );
  if (inserted.rows[0]) {
    return mapMessageRow(inserted.rows[0]);
  }
  // Conflict: the row already exists (a prior attempt persisted it). Return it so the caller's
  // flip stays idempotent.
  const existing = await client.query<Message>(
    'SELECT * FROM messages WHERE tenant_id = $1 AND external_message_id = $2 LIMIT 1',
    [input.tenant_id, input.external_message_id],
  );
  if (!existing.rows[0]) {
    // Should not happen (DO NOTHING implies a conflicting row exists), but never silently
    // return a phantom — surface it so the transaction rolls back and retries.
    throw new Error(
      `createMessageTx: conflict on (tenant_id, external_message_id) but no existing row found for ${input.external_message_id}`,
    );
  }
  return mapMessageRow(existing.rows[0]);
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
 *
 * Ordering (P2-4 Part 2, RC-11 prerequisite): a STALE revision is rejected. Same-content was
 * previously the ONLY idempotency here — the UPDATE was otherwise unconditional and compared
 * neither `num_edit` nor `edited_at` against the stored row — so replaying an OLDER edit body
 * rewound `content` to a previous revision, incremented `edit_count`, appended a bogus history
 * entry, and emitted message_edited to the merchant's inbox. Reachable from one captured signed
 * body, because the HMAC carries no timestamp; the wall-clock skew gate that WEBHOOK_DEDUPE_REPLAY
 * removes was the only thing bounding it, and the edit path returns before both inbound dedupe
 * blocks, so it has no other durable backstop. Unconditional — not flag-gated — because a stale
 * edit is never legitimate regardless of how the delivery arrived.
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

    // Read under the FOR UPDATE above, so two concurrent deliveries of the same revision serialize
    // and the second sees the first's increment. The predicate itself is pure and unit-tested.
    if (
      isStaleMessageEdit(
        { numEdit: input.numEdit, editedAt: input.editedAt },
        { editCount: mapped.edit_count, editedAt: mapped.edited_at },
      )
    ) {
      await client.query('ROLLBACK');
      return { message: mapped, changed: false };
    }

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

/**
 * Finds a recently-persisted outbound message in the conversation whose content matches
 * `content` (NULL-safe). Used to de-duplicate Meta echoes of messages we already stored
 * (the AI reply / inbox-UI reply) when the echo's `mid` differs from the id we recorded at
 * send time, so an echo never produces a duplicate row in the thread.
 */
export async function findRecentOutboundMessageByContent(
  conversationId: string,
  tenantId: string,
  content: string | null,
  withinMs: number,
): Promise<Message | null> {
  const since = new Date(Date.now() - Math.max(0, withinMs));
  const { rows } = await pool.query<Message>(
    `SELECT * FROM messages
     WHERE conversation_id = $1
       AND tenant_id = $2
       AND direction = 'outbound'
       AND created_at >= $3
       AND content IS NOT DISTINCT FROM $4
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [conversationId, tenantId, since, content ?? null],
  );
  const row = rows[0];
  return row ? mapMessageRow(row) : null;
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
