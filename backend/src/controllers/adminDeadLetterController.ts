import type { Request, Response } from 'express';
import { sendError, sendPaginated, sendSuccess } from '../utils/response';
import {
  getDeadLetterById,
  listDeadLetter,
  markDeadLetterReplayed,
  type DeadLetterStatus,
} from '../db/models/deadLetter';
import { queueByName } from '../jobs/queues';

/** P1-2 step 4: operator replay is off by default. */
function replayEnabled(): boolean {
  return (process.env.DLQ_REPLAY_ENABLED ?? 'false').trim().toLowerCase() === 'true';
}

/** GET /api/admin/dead-letter — list dead-lettered jobs for the operator dashboard. */
export async function list(req: Request, res: Response): Promise<void> {
  try {
    const { status, queue, page, limit } = req.query as unknown as {
      status?: DeadLetterStatus;
      queue?: string;
      page: number;
      limit: number;
    };
    const { rows, total } = await listDeadLetter({ status, queue, page, limit });
    sendPaginated(res, rows, page, limit, total, 'Dead-letter jobs');
  } catch (err) {
    sendError(res, 'Failed to list dead-letter jobs', 500, err);
  }
}

/**
 * POST /api/admin/dead-letter/:id/replay — re-enqueue a dead-lettered job's stored payload onto its
 * origin queue. Safe to re-run because P1-1's idempotent staging/outbox make re-delivery
 * exactly-once. Gated on DLQ_REPLAY_ENABLED.
 */
export async function replay(req: Request, res: Response): Promise<void> {
  try {
    if (!replayEnabled()) {
      sendError(res, 'Dead-letter replay is disabled (set DLQ_REPLAY_ENABLED=true)', 503);
      return;
    }

    const { id } = req.params as { id: string };
    const row = await getDeadLetterById(id);
    if (!row) {
      sendError(res, 'Dead-letter row not found', 404);
      return;
    }
    if (row.status !== 'new') {
      sendError(res, `Dead-letter row already ${row.status}`, 409);
      return;
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
