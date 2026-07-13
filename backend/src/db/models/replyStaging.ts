/**
 * P1-1 (RC-20): data-access for `ai_reply_staging`.
 *
 * A staging row is written BEFORE the channel send (status `staged`, carrying the authoritative
 * reply text + guard verdicts). After the send it is flipped to `sent`/`failed` in the same
 * transaction that persists the delivered `messages` row and records the real external id. On a
 * BullMQ retry a `sent` row no-ops the send (the reply is never re-sent or re-generated) and the
 * flip is re-driven idempotently to finish any side-effects a prior crash missed.
 */
import type { PoolClient } from 'pg';
import pool from '../pool';
import type { StagingStatus } from '../../services/replyIdempotency';

export interface ReplyStagingRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  idempotency_key: string;
  reply_slot: string;
  logical_inbound_external_id: string;
  status: StagingStatus;
  reply_text: string | null;
  attachment_urls: string[];
  guard_verdicts: Record<string, unknown>;
  external_message_id: string | null;
  message_id: string | null;
  send_attempts: number;
  created_at: Date;
  sent_at: Date | null;
}

export interface StageReplyInput {
  tenant_id: string;
  conversation_id: string;
  idempotency_key: string;
  reply_slot: string;
  logical_inbound_external_id: string;
  reply_text?: string | null;
  attachment_urls?: string[];
  guard_verdicts?: Record<string, unknown>;
}

/**
 * Stage a reply row idempotently and return the current row for this idempotency key. On first
 * call it inserts (`staged`); on a retry the `ON CONFLICT (idempotency_key) DO NOTHING` no-ops
 * and the existing row (possibly already `sent`) is returned, so the caller can decide whether to
 * send or self-heal. Runs on a caller-supplied client so it can share the flip transaction.
 */
export async function upsertStagingTx(
  client: PoolClient,
  input: StageReplyInput,
): Promise<ReplyStagingRow> {
  await client.query(
    `INSERT INTO ai_reply_staging (
       tenant_id, conversation_id, idempotency_key, reply_slot, logical_inbound_external_id,
       status, reply_text, attachment_urls, guard_verdicts
     ) VALUES ($1, $2, $3, $4, $5, 'staged', $6, $7::jsonb, $8::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.tenant_id,
      input.conversation_id,
      input.idempotency_key,
      input.reply_slot,
      input.logical_inbound_external_id,
      input.reply_text ?? null,
      JSON.stringify(input.attachment_urls ?? []),
      JSON.stringify(input.guard_verdicts ?? {}),
    ],
  );
  const { rows } = await client.query<ReplyStagingRow>(
    'SELECT * FROM ai_reply_staging WHERE idempotency_key = $1 LIMIT 1',
    [input.idempotency_key],
  );
  return rows[0];
}

/** Read a staging row by idempotency key (pool or a supplied client). */
export async function getStagingByKey(
  idempotencyKey: string,
  client?: PoolClient,
): Promise<ReplyStagingRow | null> {
  const runner = client ?? pool;
  const { rows } = await runner.query<ReplyStagingRow>(
    'SELECT * FROM ai_reply_staging WHERE idempotency_key = $1 LIMIT 1',
    [idempotencyKey],
  );
  return rows[0] ?? null;
}

/**
 * Flip a staging row to `sent`/`failed`, recording the delivered external id + persisted message
 * id and bumping `send_attempts`. Idempotent: re-driving with the same values is harmless.
 */
export async function flipStagingTx(
  client: PoolClient,
  input: {
    idempotency_key: string;
    status: Extract<StagingStatus, 'sent' | 'failed'>;
    external_message_id: string;
    message_id: string | null;
  },
): Promise<void> {
  await client.query(
    `UPDATE ai_reply_staging
        SET status = $2,
            external_message_id = $3,
            message_id = COALESCE($4, message_id),
            send_attempts = send_attempts + 1,
            sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
      WHERE idempotency_key = $1`,
    [input.idempotency_key, input.status, input.external_message_id, input.message_id],
  );
}

/**
 * Crash-resume reaper source (RC-20 edge case): staging rows that are still not `sent` and older
 * than `olderThanMs` — their AI-reply job crashed/exhausted BullMQ attempts before delivering.
 * The relay re-enqueues an ai.reply for these conversations; the `sent` check + `ON CONFLICT`
 * guarantee a resume never duplicates.
 */
export async function findOpenStagingOlderThan(
  olderThanMs: number,
  limit = 100,
): Promise<ReplyStagingRow[]> {
  const { rows } = await pool.query<ReplyStagingRow>(
    `SELECT * FROM ai_reply_staging
      WHERE status <> 'sent'
        AND created_at < now() - make_interval(secs => $1)
      ORDER BY created_at
      LIMIT $2`,
    [olderThanMs / 1000, limit],
  );
  return rows;
}
