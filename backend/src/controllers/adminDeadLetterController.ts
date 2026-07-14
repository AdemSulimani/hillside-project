import type { Request, Response } from 'express';
import { sendError, sendPaginated, sendSuccess } from '../utils/response';
import {
  getDeadLetterById,
  listDeadLetter,
  markDeadLetterReplayed,
  type DeadLetterRow,
} from '../db/models/deadLetter';
import { queueByName } from '../jobs/queues';
import { findChannelById } from '../db/models/channel';
import { isStageBeforeSendEnabled } from '../services/stageAndSend';
import type {
  AdminDeadLetterListQuery,
  AdminDeadLetterReplayBody,
} from '../validators/admin';

/** P1-2 step 4: operator replay is off by default. */
function replayEnabled(): boolean {
  return (process.env.DLQ_REPLAY_ENABLED ?? 'false').trim().toLowerCase() === 'true';
}

/** GET /api/admin/dead-letter — list dead-lettered jobs for the operator dashboard. */
export async function list(req: Request, res: Response): Promise<void> {
  try {
    // Zod-parsed query (page/limit defaults included) lands on req.validated.query — the validate
    // middleware only writes back to the request for `body` (see adminCommissionController).
    const { status, queue, page, limit } = (req.validated?.query ??
      req.query) as unknown as AdminDeadLetterListQuery;
    const { rows, total } = await listDeadLetter({ status, queue, page, limit });
    sendPaginated(res, rows, page, limit, total, 'Dead-letter jobs');
  } catch (err) {
    sendError(res, 'Failed to list dead-letter jobs', 500, err);
  }
}

/**
 * Replaying an `ai.reply` job is only exactly-once-safe when P1-1's reply staging is active for the
 * target channel — without it, a replayed reply can double-send to the customer. Resolves the
 * channel from the stored payload and returns a refusal reason when staging is off or the channel
 * cannot be resolved (fail-safe); `null` means the replay is safe.
 */
async function aiReplyReplayBlockReason(row: DeadLetterRow): Promise<string | null> {
  const payload = row.payload as { channelId?: unknown; tenantId?: unknown };
  const channelId = typeof payload.channelId === 'string' ? payload.channelId : null;
  const tenantId = typeof payload.tenantId === 'string' ? payload.tenantId : row.tenant_id;
  if (!channelId || !tenantId) {
    return 'cannot resolve the reply channel from the stored payload (missing channelId/tenantId)';
  }

  let channel;
  try {
    channel = await findChannelById(channelId, tenantId);
  } catch {
    return 'channel lookup failed';
  }
  if (!channel) {
    return `channel ${channelId} not found for tenant ${tenantId} (disconnected?)`;
  }
  if (!isStageBeforeSendEnabled(channel.type)) {
    return `reply staging (AI_REPLY_STAGE_BEFORE_SEND) is not enabled for '${channel.type}', so re-delivery is not exactly-once`;
  }
  return null;
}

/**
 * POST /api/admin/dead-letter/:id/replay — re-enqueue a dead-lettered job's stored payload onto its
 * origin queue. Safe to re-run because P1-1's idempotent staging/outbox make re-delivery
 * exactly-once — so an `ai.reply` replay is refused when staging is not active for its channel
 * (override with `force: true`). Rows whose payload was PII-redacted at dead-letter time are never
 * replayable (the original content is gone). Gated on DLQ_REPLAY_ENABLED.
 */
export async function replay(req: Request, res: Response): Promise<void> {
  try {
    if (!replayEnabled()) {
      sendError(res, 'Dead-letter replay is disabled (set DLQ_REPLAY_ENABLED=true)', 503);
      return;
    }

    const { id } = req.params as { id: string };
    const { force } = ((req.validated?.body ?? req.body) ?? {
      force: false,
    }) as AdminDeadLetterReplayBody;

    const row = await getDeadLetterById(id);
    if (!row) {
      sendError(res, 'Dead-letter row not found', 404);
      return;
    }
    if (row.status !== 'new') {
      sendError(res, `Dead-letter row already ${row.status}`, 409);
      return;
    }

    // Redacted payloads are refused outright (no force override): the payload was PII-masked at
    // dead-letter time, so replaying it would re-process masked content — the original is gone.
    if (row.payload_redacted) {
      sendError(
        res,
        'Cannot replay: payload was PII-redacted at dead-letter time and the original content is not recoverable',
        409,
      );
      return;
    }

    // An ai.reply replay rides P1-1's staging idempotency — refuse when it is not active.
    if (row.queue_name === 'ai' && row.job_name === 'ai.reply' && !force) {
      const blockReason = await aiReplyReplayBlockReason(row);
      if (blockReason) {
        sendError(res, `Refusing ai.reply replay: ${blockReason}. Pass { "force": true } to override.`, 409);
        return;
      }
    }

    const queue = queueByName[row.queue_name];
    if (!queue) {
      sendError(res, `Unknown origin queue '${row.queue_name}'`, 400);
      return;
    }

    await queue.add(row.job_name ?? row.queue_name, row.payload, { jobId: `replay-${row.id}` });
    await markDeadLetterReplayed(row.id);

    sendSuccess(res, { id: row.id, queue: row.queue_name, jobName: row.job_name }, 'Dead-letter job re-enqueued');
  } catch (err) {
    sendError(res, 'Failed to replay dead-letter job', 500, err);
  }
}
