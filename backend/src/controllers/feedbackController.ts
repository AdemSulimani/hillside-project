import type { Request, Response } from 'express';
import pool from '../db/pool';
import { ensureAIConfigForTenant, incrementFeedbackCount } from '../db/models/aiConfig';
import { createFeedbackLog, listFeedbackLogsForTenant } from '../db/models/feedbackLog';
import { findMessageByIdForTenant } from '../db/models/message';
import { sendError, sendPaginated, sendSuccess } from '../utils/response';
import type { FeedbackListQuery, StoreFeedbackBody } from '../validators/feedback';

export async function store(req: Request, res: Response): Promise<void> {
  const tenantId = req.user!.tenantId!;
  const body = (req.validated?.body ?? req.body) as StoreFeedbackBody;

  try {
    const message = await findMessageByIdForTenant(body.message_id, tenantId);
    if (!message) {
      sendError(res, 'Message not found', 404);
      return;
    }
    if (message.sent_by !== 'ai') {
      sendError(res, 'Feedback can only be submitted for AI-generated messages', 400);
      return;
    }

    await ensureAIConfigForTenant(tenantId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await createFeedbackLog(
        {
          tenant_id: tenantId,
          message_id: message.id,
          conversation_id: message.conversation_id,
          original_ai_response: message.content ?? '',
          corrected_response: body.corrected_response,
          reason: body.reason,
        },
        client,
      );
      const updated = await incrementFeedbackCount(tenantId, client);
      if (!updated) {
        await client.query('ROLLBACK');
        sendError(res, 'AI configuration not found for tenant', 500);
        return;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    sendSuccess(res, { submitted: true }, 'Feedback recorded successfully', 201);
  } catch (err) {
    sendError(res, 'Failed to store feedback', 500, err);
  }
}

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as FeedbackListQuery;

    const { logs, total } = await listFeedbackLogsForTenant({
      tenantId,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });

    sendPaginated(res, logs, query.page, query.limit, total, 'Feedback logs retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve feedback logs', 500, err);
  }
}
