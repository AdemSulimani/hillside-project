import type { PoolClient } from 'pg';
import pool from '../pool';
import type { ChannelType } from './channel';

/** P2-2 (RC-07/08/22): the deterministic order-lifecycle stage persisted per conversation. */
export type OrderStage = 'browsing' | 'collecting' | 'awaiting_confirmation' | 'confirmed';

export interface Conversation {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string | null;
  status: string;
  last_message_at: Date;
  human_override_until: Date | null;
  ai_paused: boolean;
  ai_paused_reason: string | null;
  ai_paused_at: Date | null;
  fully_ai_handled: boolean;
  human_replied: boolean;
  // P2-2 (migration 077) — order_stage FSM + slot store. Populated by SELECT * loads; OPTIONAL
  // because the explicit-column UI projections (ConversationDetail, findPausedConversationsByTenant,
  // listConversationsForContact*) legitimately omit them. The AI order path reads them from a
  // SELECT * load and guards with `normalizeStage(...)` / `?? false`, so absence is safe.
  order_stage?: OrderStage | null;
  order_stage_updated_at?: Date | null;
  data_confirmation_sent?: boolean;
  order_closing_asked?: boolean;
  order_consent_at?: Date | null;
  order_consent_inbound_id?: string | null;
  slot_customer_name?: string | null;
  slot_customer_phone?: string | null;
  slot_delivery_address?: string | null;
  reply_locale?: 'sq' | 'en' | null;
  reply_locale_updated_at?: Date | null;
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
  reason: string | null = null,
): Promise<Conversation | null> {
  // P0-5: on pause, stamp ai_paused_at (so the invariant monitor can spot a conversation
  // left paused past a newer inbound) and record ai_paused_reason (part 3 keys the
  // rate-limit auto-expiry on 'rate_limit_exceeded'). On resume, clear both — and, as
  // before, clear any human hold.
  const { rows } = await client.query<Conversation>(
    `UPDATE conversations
     SET
       ai_paused = $3,
       ai_paused_reason = CASE WHEN $3 = TRUE THEN $4 ELSE NULL END,
       ai_paused_at = CASE WHEN $3 = TRUE THEN now() ELSE NULL END,
       human_override_until = CASE WHEN $3 = FALSE THEN NULL ELSE human_override_until END,
       updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, aiPaused, reason],
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

// ---------------------------------------------------------------------------
// P2-2 (RC-07/08/22/10) — order_stage FSM + slot store writers.
//
// Every writer is monotone/idempotent so it is safe under BullMQ retries: markers only flip
// false -> true; slot writes COALESCE-keep (never null a known value); the stage seed only fires
// when order_stage IS NULL. Consumers stay behind the ORDER_STAGE_MACHINE flag.
// ---------------------------------------------------------------------------

/**
 * Persist the FSM's decided stage. On the transition to `confirmed`, pass `consentAt` (the stored
 * consent-inbound timestamp — the RC-22 commission anchor) and `consentInboundId` (the
 * retry-idempotency anchor); both COALESCE so a non-null value overwrites and an omitted one keeps.
 */
export async function advanceOrderStage(
  id: string,
  tenantId: string,
  nextStage: OrderStage,
  opts: { consentAt?: Date | null; consentInboundId?: string | null } = {},
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations
     SET order_stage = $3,
         order_stage_updated_at = now(),
         order_consent_at = COALESCE($4, order_consent_at),
         order_consent_inbound_id = COALESCE($5, order_consent_inbound_id),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, nextStage, opts.consentAt ?? null, opts.consentInboundId ?? null],
  );
}

/** Sticky marker: the assistant has sent the data-confirmation request (enters awaiting_confirmation). */
export async function markDataConfirmationSent(
  id: string,
  tenantId: string,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations SET data_confirmation_sent = TRUE, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND data_confirmation_sent IS DISTINCT FROM TRUE`,
    [id, tenantId],
  );
}

/** Sticky marker: the assistant has asked the order-closing question (replaces the ~40-call LLM loop). */
export async function markOrderClosingAsked(
  id: string,
  tenantId: string,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations SET order_closing_asked = TRUE, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND order_closing_asked IS DISTINCT FROM TRUE`,
    [id, tenantId],
  );
}

/** COALESCE-keep slot cache write: only fills a slot, never nulls a previously-known value. */
export async function persistOrderSlots(
  id: string,
  tenantId: string,
  slots: { name?: string | null; phone?: string | null; address?: string | null },
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations
     SET slot_customer_name = COALESCE($3, slot_customer_name),
         slot_customer_phone = COALESCE($4, slot_customer_phone),
         slot_delivery_address = COALESCE($5, slot_delivery_address),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, slots.name ?? null, slots.phone ?? null, slots.address ?? null],
  );
}

/** RC-10 sticky locale write; stamps reply_locale_updated_at as the hysteresis anchor. */
export async function setStickyReplyLocale(
  id: string,
  tenantId: string,
  locale: 'sq' | 'en',
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations
     SET reply_locale = $3, reply_locale_updated_at = now(), updated_at = now()
     WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId, locale],
  );
}

/**
 * One-time deterministic seed for a legacy conversation whose order_stage IS NULL (e.g. mid-flow at
 * cutover). Reconstructs the sticky markers + stage from regex scans over existing history. The
 * `order_stage IS NULL` guard makes it fire at most once — thereafter the incremental writers own
 * the state.
 */
export async function seedOrderStageState(
  id: string,
  tenantId: string,
  seed: { stage: OrderStage; dataConfirmationSent: boolean; orderClosingAsked: boolean },
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `UPDATE conversations
     SET order_stage = $3,
         order_stage_updated_at = now(),
         data_confirmation_sent = $4,
         order_closing_asked = $5,
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND order_stage IS NULL`,
    [id, tenantId, seed.stage, seed.dataConfirmationSent, seed.orderClosingAsked],
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
       -- Manual toggle: leave ai_paused_at/reason NULL so a deliberately human-owned pause
       -- is excluded from the automated-pause invariant monitor (and never auto-resumed).
       ai_paused_reason = NULL,
       ai_paused_at = NULL,
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
       c.ai_paused_reason,
       c.ai_paused_at,
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
       c.ai_paused_reason,
       c.ai_paused_at,
       c.fully_ai_handled,
       c.human_replied,
       c.created_at,
       c.updated_at,
       COALESCE(ch.type, 'facebook') AS channel_type,
       COALESCE(ch.name, 'Disconnected channel') AS channel_name
     FROM conversations c
     LEFT JOIN channels ch ON ch.id = c.channel_id AND ch.tenant_id = c.tenant_id
     WHERE c.contact_id = $1 AND c.tenant_id = $2
     ORDER BY c.last_message_at DESC
     LIMIT $3 OFFSET $4`,
    [contactId, tenantId, limit, offset],
  );

  return { rows, total };
}

export interface PauseInvariantViolation {
  id: string;
  tenant_id: string;
  ai_paused_at: Date;
  ai_paused_reason: string | null;
}

/**
 * P0-5 (RC-14) part 4 — the auto-resume invariant, as a query. Returns conversations that
 * are still AI-paused (via an AUTOMATED pause, i.e. ai_paused_at is stamped — manual
 * toggles leave it NULL) with an inbound message NEWER than the pause and no OPEN alert
 * of ANY kind: exactly the permanent-silence dead-ends auto-resume is meant to eliminate.
 * A pause with an open NON-sensitive alert awaiting normal human resolution is a
 * by-design pending state (part 2 resumes it at resolve time), not a violation —
 * excluding only sensitive alerts would flood the monitor with pending escalations and
 * bury the real dead-ends. Read only — the monitor logs these; it never resumes.
 */
export async function findPauseInvariantViolations(
  limit = 500,
): Promise<PauseInvariantViolation[]> {
  const { rows } = await pool.query<PauseInvariantViolation>(
    `SELECT c.id, c.tenant_id, c.ai_paused_at, c.ai_paused_reason
       FROM conversations c
      WHERE c.ai_paused = true
        AND c.ai_paused_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM messages m
           WHERE m.conversation_id = c.id
             AND m.tenant_id = c.tenant_id
             AND m.direction = 'inbound'
             AND m.created_at > c.ai_paused_at
        )
        AND NOT EXISTS (
          SELECT 1 FROM ai_alerts a
           WHERE a.conversation_id = c.id
             AND a.tenant_id = c.tenant_id
             AND a.status IN ('unread', 'read')
        )
      ORDER BY c.ai_paused_at ASC
      LIMIT $1`,
    [limit],
  );
  return rows;
}
