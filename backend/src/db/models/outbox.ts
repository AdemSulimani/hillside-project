/**
 * P1-1 (RC-20, RC-21): data-access for the transactional outbox.
 *
 * A row is written in the SAME Postgres transaction as the state change it describes (the
 * inbound message persist, or the outbound reply flip), so a crash between the DB write and the
 * BullMQ enqueue / DB side-effect can no longer silently lose it. The relay (jobs/outboxRelay.ts)
 * claims rows with `FOR UPDATE SKIP LOCKED` (no double-dispatch across workers), performs the
 * effect, and marks the row terminal. `dedupe_key` (unique) makes every effect exactly-once.
 *
 * All functions run raw parameterised SQL against the shared pool / a caller-supplied client,
 * matching the repo's no-ORM convention.
 */
import type { PoolClient } from 'pg';
import pool from '../pool';

export type OutboxTopic =
  | 'ai.reply'
  | 'analytics.ai_reply_sent'
  | 'usecase.eval'
  | 'reply.ratecount'
  | 'alert.message_send_failed'
  | 'alert.product_image_unavailable';

export type OutboxStatus = 'pending' | 'processing' | 'done' | 'dead';

export interface OutboxRow {
  id: string; // BIGINT identity — pg returns it as a string
  tenant_id: string;
  conversation_id: string | null;
  topic: OutboxTopic | string;
  dedupe_key: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  created_at: Date;
  processed_at: Date | null;
  last_error: string | null;
}

export interface InsertOutboxInput {
  tenant_id: string;
  conversation_id?: string | null;
  topic: OutboxTopic;
  dedupe_key: string;
  payload?: Record<string, unknown>;
  /** Defaults to now(); pass a future time to carry a debounce delay or retry backoff. */
  available_at?: Date;
  max_attempts?: number;
}

/** Build the canonical dedupe key for the ai.reply enqueue-intent. */
export function aiReplyDedupeKey(conversationId: string, inboundExternalId: string): string {
  return `ai.reply:${conversationId}:${inboundExternalId}`;
}

/**
 * Insert a side-effect outbox row, idempotent on `dedupe_key`. A retry of the producing
 * transaction (or a re-driven flip) collides and no-ops, so the effect fires exactly once.
 */
export async function insertOutboxTx(
  client: PoolClient,
  input: InsertOutboxInput,
): Promise<void> {
  await client.query(
    `INSERT INTO transactional_outbox (tenant_id, conversation_id, topic, dedupe_key, payload, available_at, max_attempts)
     VALUES ($1, $2, $3, $4, $5::jsonb, COALESCE($6, now()), COALESCE($7, 10))
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      input.tenant_id,
      input.conversation_id ?? null,
      input.topic,
      input.dedupe_key,
      JSON.stringify(input.payload ?? {}),
      input.available_at ?? null,
      input.max_attempts ?? null,
    ],
  );
}

/**
 * Upsert the single live `ai.reply` enqueue-intent for a conversation (RC-21 + burst debounce).
 * Conflicts on the partial unique index `idx_outbox_live_ai_reply` — at most one pending
 * ai.reply per conversation. A newer inbound within the debounce window resets `available_at`
 * and repoints the payload/dedupe_key to the latest inbound (replacing the racy
 * getJobs→remove→add debounce).
 */
export async function upsertLiveAiReplyTx(
  client: PoolClient,
  input: {
    tenant_id: string;
    conversation_id: string;
    dedupe_key: string;
    payload: Record<string, unknown>;
    available_at: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO transactional_outbox (tenant_id, conversation_id, topic, dedupe_key, payload, status, available_at)
     VALUES ($1, $2, 'ai.reply', $3, $4::jsonb, 'pending', $5)
     ON CONFLICT (conversation_id) WHERE topic = 'ai.reply' AND status = 'pending'
     DO UPDATE SET payload = EXCLUDED.payload,
                   available_at = EXCLUDED.available_at,
                   dedupe_key = EXCLUDED.dedupe_key`,
    [
      input.tenant_id,
      input.conversation_id,
      input.dedupe_key,
      JSON.stringify(input.payload),
      input.available_at,
    ],
  );
}

/**
 * Whether a conversation currently has a live (pending) ai.reply enqueue-intent. The RC-21
 * dedupe re-check keys on this: a persisted-but-un-enqueued inbound (crash between persist and
 * enqueue) has no live row, so the caller re-inserts one instead of silently returning.
 */
export async function hasLiveAiReply(conversationId: string): Promise<boolean> {
  const { rows } = await pool.query<{ one: number }>(
    `SELECT 1 AS one FROM transactional_outbox
     WHERE conversation_id = $1 AND topic = 'ai.reply' AND status = 'pending'
     LIMIT 1`,
    [conversationId],
  );
  return rows.length > 0;
}

/**
 * Atomically claim a batch of drainable rows for this worker. Claims rows that are `pending` and
 * due, plus `processing` rows whose lease expired (a worker crashed mid-dispatch). `FOR UPDATE
 * SKIP LOCKED` guarantees concurrent drainers never grab the same row. Increments `attempts` on
 * each claim (one claim = one dispatch attempt).
 */
export async function claimOutboxBatch(
  client: PoolClient,
  workerId: string,
  batchSize: number,
  leaseSeconds: number,
): Promise<OutboxRow[]> {
  const { rows } = await client.query<OutboxRow>(
    `WITH claimed AS (
       SELECT id FROM transactional_outbox
       WHERE (status = 'pending' AND available_at <= now())
          OR (status = 'processing' AND locked_at < now() - make_interval(secs => $3))
       ORDER BY available_at, id
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     UPDATE transactional_outbox o
        SET status = 'processing', locked_at = now(), locked_by = $1, attempts = o.attempts + 1
       FROM claimed
      WHERE o.id = claimed.id
      RETURNING o.*`,
    [workerId, batchSize, leaseSeconds],
  );
  return rows;
}

/** Mark a claimed row successfully dispatched. */
export async function markOutboxDone(client: PoolClient, id: string): Promise<void> {
  await client.query(
    `UPDATE transactional_outbox SET status = 'done', processed_at = now(), locked_at = NULL, locked_by = NULL
     WHERE id = $1`,
    [id],
  );
}

/** Return a row to `pending` with a future `available_at` (retry with backoff). */
export async function markOutboxRetry(
  client: PoolClient,
  id: string,
  availableAt: Date,
  error: string,
): Promise<void> {
  await client.query(
    `UPDATE transactional_outbox
        SET status = 'pending', available_at = $2, locked_at = NULL, locked_by = NULL, last_error = $3
      WHERE id = $1`,
    [id, availableAt, error.slice(0, 2000)],
  );
}

/** Terminally dead-letter a row that exhausted its attempts. */
export async function markOutboxDead(client: PoolClient, id: string, error: string): Promise<void> {
  await client.query(
    `UPDATE transactional_outbox
        SET status = 'dead', processed_at = now(), locked_at = NULL, locked_by = NULL, last_error = $2
      WHERE id = $1`,
    [id, error.slice(0, 2000)],
  );
}
