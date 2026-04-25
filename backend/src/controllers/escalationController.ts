import type { Request, Response } from 'express';
import { listAIAlertsForTenant } from '../db/models/aiAlert';
import { sendError, sendPaginated } from '../utils/response';
import type { EscalationListQuery } from '../validators/escalation';

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as EscalationListQuery;

    const { rows, total } = await listAIAlertsForTenant({
      tenantId,
      reason: 'usage_question_unanswered',
      page: query.page,
      limit: query.limit,
    });

    sendPaginated(res, rows, query.page, query.limit, total, 'Usage escalations retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve escalations', 500, err);
  }
}
