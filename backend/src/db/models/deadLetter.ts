/**
 * P1-2 (RC-20/21/18): data-access for the `dead_letter` table.
 *
 * A dead_letter row is the durable record of a BullMQ job that BullMQ has given up on — either an
 * exhausted transient failure or a stalled/terminal one. The failure handler writes it (idempotent
 * on `(queue_name, job_id)`); the admin replay endpoint reads and re-enqueues it; the monitor gauges
 * and prunes it. Raw parameterised SQL against the shared pool / a caller-supplied client, matching
 * the repo's no-ORM convention (mirrors db/models/outbox.ts).
 */
import type { PoolClient } from 'pg';
import pool from '../pool';
import type { JobFailureClassification } from '../../jobs/failureClassifier';

type Db = PoolClient | typeof pool;

export type DeadLetterStatus = 'new' | 'replayed' | 'ignored';

export interface DeadLetterRow {
  id: string; // BIGINT identity — pg returns it as a string
  queue_name: string;
  job_id: string;
  job_name: string | null;
  tenant_id: string | null;
  conversation_id: string | null;
  trace_id: string | null;
  classification: JobFailureClassification;
  reason: string;
  error: string | null;
  attempts: number;
  max_attempts: number | null;
  payload: Record<string, unknown>;
  status: DeadLetterStatus;
  created_at: Date;
  replayed_at: Date | null;
}

export interface InsertDeadLetterInput {
  queue_name: string;
  job_id: string;
  job_name?: string | null;
  tenant_id?: string | null;
  conversation_id?: string | null;
  trace_id?: string | null;
  classification: JobFailureClassification;
  reason: string;
  error?: string | null;
  attempts: number;
  max_attempts?: number | null;
  payload?: Record<string, unknown>;
}

/**
 * Insert a dead-letter row, idempotent on `(queue_name, job_id)`. Returns the new row id, or `null`
 * when a row already existed (the `failed` listener can fire more than once for the same job) — the
 * caller keys "is this the first time we're dead-lettering this job?" on a non-null return, so alerts
 * fire exactly once.
 */
export async function insertDeadLetter(
  input: InsertDeadLetterInput,
  client: Db = pool,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO dead_letter
       (queue_name, job_id, job_name, tenant_id, conversation_id, trace_id,
        classification, reason, error, attempts, max_attempts, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
     ON CONFLICT (queue_name, job_id) DO NOTHING
     RETURNING id`,
    [
      input.queue_name,
      input.job_id,
      input.job_name ?? null,
      input.tenant_id ?? null,
      input.conversation_id ?? null,
      input.trace_id ?? null,
      input.classification,
      input.reason,
      input.error ? input.error.slice(0, 2000) : null,
      input.attempts,
      input.max_attempts ?? null,
      JSON.stringify(input.payload ?? {}),
    ],
  );
  return rows[0]?.id ?? null;
}

export async function getDeadLetterById(id: string, client: Db = pool): Promise<DeadLetterRow | null> {
  const { rows } = await client.query<DeadLetterRow>(
    'SELECT * FROM dead_letter WHERE id = $1 LIMIT 1',
    [id],
  );
  return rows[0] ?? null;
}

/** Mark a row replayed (operator re-enqueued its payload). */
export async function markDeadLetterReplayed(id: string, client: Db = pool): Promise<void> {
  await client.query(
    `UPDATE dead_letter SET status = 'replayed', replayed_at = now() WHERE id = $1`,
    [id],
  );
}

export interface ListDeadLetterParams {
  status?: DeadLetterStatus;
  queue?: string;
  page: number;
  limit: number;
}

export async function listDeadLetter(
  params: ListDeadLetterParams,
): Promise<{ rows: DeadLetterRow[]; total: number }> {
  const cap = Math.min(Math.max(1, params.limit), 100);
  const offset = (Math.max(1, params.page) - 1) * cap;

  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.status) {
    conditions.push(`status = $${idx}`);
    values.push(params.status);
    idx += 1;
  }
  if (params.queue) {
    conditions.push(`queue_name = $${idx}`);
    values.push(params.queue);
    idx += 1;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM dead_letter ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const { rows } = await pool.query<DeadLetterRow>(
    `SELECT * FROM dead_letter ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, cap, offset],
  );
  return { rows, total };
}

/**
 * Backlog metrics for the monitor/breaker: `backlog` = un-actioned rows (`status='new'`);
 * `recentHour` = rows created in the last hour (the burst signal during an incident).
 */
export async function countDeadLetterMetrics(
  client: Db = pool,
): Promise<{ backlog: number; recentHour: number }> {
  const { rows } = await client.query<{ backlog: string; recent_hour: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'new')::text AS backlog,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '1 hour')::text AS recent_hour
     FROM dead_letter`,
  );
  return {
    backlog: parseInt(rows[0]?.backlog ?? '0', 10),
    recentHour: parseInt(rows[0]?.recent_hour ?? '0', 10),
  };
}

/**
 * Retention prune: delete already-actioned (`replayed`/`ignored`) rows older than `retentionDays`.
 * Never touches `new` rows — an un-actioned dead letter always requires an operator decision.
 */
export async function pruneReplayedDeadLetter(
  retentionDays: number,
  client: Db = pool,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM dead_letter
      WHERE status IN ('replayed', 'ignored')
        AND created_at < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return rowCount ?? 0;
}
