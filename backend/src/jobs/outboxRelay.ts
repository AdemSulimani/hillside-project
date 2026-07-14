/**
 * P1-1 (RC-20, RC-21): the transactional-outbox relay.
 *
 * A scheduled drain job (registered on `defaultQueue`, modelled on `pauseInvariantMonitor` /
 * the embedding-reconcile fast lane) claims due `transactional_outbox` rows with `FOR UPDATE
 * SKIP LOCKED` — so concurrent workers never dispatch the same row — performs each row's effect,
 * and marks it terminal. Because every outbox row was written in the SAME Postgres transaction as
 * the state change it describes (the inbound message persist, or the outbound reply flip), a
 * crash between that commit and the effect can no longer lose the ai.reply job (RC-21) or a
 * delivered reply's side-effects (RC-20). `dedupe_key` uniqueness + deterministic BullMQ jobIds
 * make each effect exactly-once even across a lease-expiry re-claim.
 *
 * Gated by two flags:
 *   OUTBOX_RELAY_ENABLED   — run the drain loop at all.
 *   OUTBOX_DISPATCH_ENABLED — actually perform effects. When off (shadow mode) the relay claims
 *                             rows and immediately releases them WITHOUT effect, so the plumbing
 *                             (claim/lock/SKIP LOCKED, scheduler registration) can be validated in
 *                             production while the legacy direct enqueue still owns delivery.
 */
import pool from '../db/pool';
import { defaultQueue, aiQueue } from './queues';
import type { AIReplyJobData } from './processAIReply';
import { socketService } from '../services/socketService';
import { redisConnection } from './redisConnection';
import { RATE_LIMIT_DELIVERED_INCR_SCRIPT } from '../services/rateLimitDeliveredCount';

/** BullMQ's aiQueue is typed to AIReplyJobData; it also carries the use-case-eval job. This
 * narrow escape hatch matches the cast the pipeline uses for the same mixed-payload queue. */
const aiQueueAdd = (aiQueue as unknown as {
  add: (name: string, data: unknown, opts?: unknown) => Promise<unknown>;
}).add.bind(aiQueue);
import { createAIAlert } from '../db/models/aiAlert';
import { insertLedgerTx, type LedgerRecord } from '../db/models/aiDecisionLedger';
import {
  claimOutboxBatch,
  markOutboxDone,
  markOutboxRetry,
  markOutboxDead,
  type OutboxRow,
} from '../db/models/outbox';

const OUTBOX_RELAY_ENABLED =
  (process.env.OUTBOX_RELAY_ENABLED ?? 'false').trim().toLowerCase() === 'true';

const OUTBOX_DISPATCH_ENABLED =
  (process.env.OUTBOX_DISPATCH_ENABLED ?? 'false').trim().toLowerCase() === 'true';

/** Poll cadence in ms. The debounce delay lives in each row's `available_at`, not here. */
export const OUTBOX_RELAY_INTERVAL_MS = Math.max(
  250,
  Number(process.env.OUTBOX_RELAY_INTERVAL_MS ?? '1000') || 1000,
);

const OUTBOX_RELAY_BATCH_SIZE = Math.max(
  1,
  Number(process.env.OUTBOX_RELAY_BATCH_SIZE ?? '50') || 50,
);

/** Lease before a claimed-but-unfinished (crashed mid-dispatch) row can be re-claimed. */
const OUTBOX_RELAY_LEASE_SECONDS = Math.max(
  30,
  Number(process.env.OUTBOX_RELAY_LEASE_SECONDS ?? '120') || 120,
);

/** Stable-ish worker id for the `locked_by` column (diagnostics only). */
const WORKER_ID = `outboxRelay:${process.pid}`;

/** Exponential backoff (capped) for a failed effect, in ms. */
function retryBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000, 1000 * 2 ** Math.min(attempts, 8));
}

function futureDate(ms: number): Date {
  return new Date(Date.now() + ms);
}

/**
 * Perform one row's effect. DB-write effects (analytics, alerts) run their INSERT AND the
 * mark-done in a single transaction so a crash mid-effect rolls both back (the lease reaper then
 * re-drives cleanly). Queue effects (ai.reply, usecase.eval) use a deterministic jobId so a
 * lease-expiry double-add is BullMQ-deduped, then mark done.
 *
 * Returns true on success, false to leave the row for retry/dead-lettering by the caller.
 */
async function dispatchRow(row: OutboxRow): Promise<boolean> {
  switch (row.topic) {
    case 'ai.reply': {
      await aiQueueAdd('ai.reply', row.payload as unknown as AIReplyJobData, {
        jobId: `outbox-ai-reply-${row.id}`,
        delay: 0,
      });
      await markDoneStandalone(row.id);
      return true;
    }
    case 'usecase.eval': {
      const p = row.payload as { conversationId?: string; tenantId?: string; delayMs?: number };
      if (p.conversationId && p.tenantId) {
        await aiQueueAdd(
          'evaluateConversationUseCase',
          { conversationId: p.conversationId, tenantId: p.tenantId },
          {
            jobId: `eval-usecase-${p.conversationId}`,
            delay: typeof p.delayMs === 'number' ? p.delayMs : 4 * 60 * 60 * 1000,
            removeOnComplete: true,
            // No removeOnFail override: the queue-level trim (removeOnFail: 500) applies, so
            // failed eval jobs can no longer accumulate unbounded in Redis (EV-042).
          },
        );
      }
      await markDoneStandalone(row.id);
      return true;
    }
    case 'reply.ratecount': {
      // P0-6 (RC-18) via P1-1: charge the 25/h budget for a delivered reply. The row is written
      // in the reply-flip transaction, so a crash between the flip commit and the INCR can no
      // longer lose the count. The Lua script's NX marker makes the charge exactly-once even if
      // this row is re-driven after a lease expiry.
      const p = row.payload as { rate_limit_key?: string; marker_key?: string; ttl_seconds?: number };
      if (p.rate_limit_key && p.marker_key) {
        await redisConnection.eval(
          RATE_LIMIT_DELIVERED_INCR_SCRIPT,
          2,
          p.rate_limit_key,
          p.marker_key,
          String(p.ttl_seconds ?? 3600),
        );
      }
      await markDoneStandalone(row.id);
      return true;
    }
    case 'analytics.ai_reply_sent': {
      await withEffectTxn(row.id, async (client) => {
        await client.query(
          `INSERT INTO analytics_events (tenant_id, event_type, metadata) VALUES ($1, $2, $3::jsonb)`,
          [row.tenant_id, 'ai_reply_sent', JSON.stringify(row.payload ?? {})],
        );
      });
      return true;
    }
    case 'alert.message_send_failed':
    case 'alert.product_image_unavailable': {
      const reason =
        row.topic === 'alert.message_send_failed'
          ? 'message_send_failed'
          : 'product_image_unavailable';
      const p = row.payload as {
        conversation_id?: string;
        message_id?: string | null;
        details?: Record<string, unknown> | null;
        emit?: Record<string, unknown>;
      };
      await withEffectTxn(row.id, async (client) => {
        await createAIAlert(
          {
            tenant_id: row.tenant_id,
            conversation_id: p.conversation_id ?? row.conversation_id ?? null,
            message_id: p.message_id ?? null,
            reason,
            details: p.details ?? null,
          },
          client,
        );
      });
      // Best-effort real-time ping after commit; the durable alert row already exists and the UI
      // also polls, so a missed emit self-heals.
      if (row.conversation_id) {
        try {
          socketService.emitConversationUpdated(row.tenant_id, row.conversation_id);
        } catch {
          /* ignore */
        }
      }
      return true;
    }
    case 'ledger.write': {
      // P1-5: the payload is a pre-redacted LedgerRecord (redaction ran at enqueue). insertLedgerTx
      // re-runs the redaction pass idempotently and `ON CONFLICT (idempotency_key) DO NOTHING`s.
      await withEffectTxn(row.id, async (client) => {
        await insertLedgerTx(client, row.payload as unknown as LedgerRecord);
      });
      return true;
    }
    default: {
      // Unknown topic — do not spin forever; dead-letter it so it is visible.
      console.warn('[outboxRelay] unknown topic, dead-lettering', { id: row.id, topic: row.topic });
      const client = await pool.connect();
      try {
        await markOutboxDead(client, row.id, `unknown topic: ${row.topic}`);
      } finally {
        client.release();
      }
      return true;
    }
  }
}

/** Mark a queue-effect row done in its own short transaction (the enqueue already happened). */
async function markDoneStandalone(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await markOutboxDone(client, id);
  } finally {
    client.release();
  }
}

/** Run a DB-write effect and its mark-done atomically. */
async function withEffectTxn(
  id: string,
  effect: (client: import('pg').PoolClient) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await effect(client);
    await markOutboxDone(client, id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Record a dispatch failure: retry with backoff, or dead-letter once attempts are exhausted. */
async function recordFailure(row: OutboxRow, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const client = await pool.connect();
  try {
    if (row.attempts >= row.max_attempts) {
      await markOutboxDead(client, row.id, message);
      console.error('[outboxRelay] row dead-lettered after exhausting attempts', {
        id: row.id,
        topic: row.topic,
        attempts: row.attempts,
        error: message,
      });
    } else {
      await markOutboxRetry(client, row.id, futureDate(retryBackoffMs(row.attempts)), message);
    }
  } finally {
    client.release();
  }
}

/**
 * Drain the outbox until empty (or a bounded number of batches, so one tick cannot run forever).
 * Each batch is claimed in its own transaction; effects run outside the claim transaction so a
 * slow effect never holds the claim lock.
 */
export async function processOutboxRelay(): Promise<void> {
  if (!OUTBOX_RELAY_ENABLED) return;

  const MAX_BATCHES = 20;
  let processed = 0;

  for (let batchNo = 0; batchNo < MAX_BATCHES; batchNo += 1) {
    const claimClient = await pool.connect();
    let batch: OutboxRow[];
    try {
      await claimClient.query('BEGIN');
      batch = await claimOutboxBatch(
        claimClient,
        WORKER_ID,
        OUTBOX_RELAY_BATCH_SIZE,
        OUTBOX_RELAY_LEASE_SECONDS,
      );
      await claimClient.query('COMMIT');
    } catch (err) {
      await claimClient.query('ROLLBACK').catch(() => undefined);
      console.error('[outboxRelay] claim batch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    } finally {
      claimClient.release();
    }

    if (batch.length === 0) break;

    for (const row of batch) {
      if (!OUTBOX_DISPATCH_ENABLED) {
        // Shadow mode: prove the claim/lock plumbing without performing effects, and mark the row
        // done so it drains exactly once (no busy-loop). The legacy direct enqueue still delivers
        // while dispatch is off, so a shadow-drained row is never lost.
        await markDoneStandalone(row.id);
        continue;
      }
      try {
        await dispatchRow(row);
        processed += 1;
      } catch (err) {
        await recordFailure(row, err);
      }
    }
  }

  if (processed > 0) {
    console.info('[outboxRelay] drained outbox rows', { processed });
  }
}

export async function initOutboxRelayScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    'outboxDrain',
    { every: OUTBOX_RELAY_INTERVAL_MS },
    {
      name: 'outboxDrain',
      data: {} as Record<string, never>,
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    },
  );

  console.info('[jobs] Outbox relay scheduler registered', {
    everyMs: OUTBOX_RELAY_INTERVAL_MS,
    dispatch: OUTBOX_DISPATCH_ENABLED,
  });
}
