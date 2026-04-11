import type { Request, Response } from 'express';
import { getStatisticsSummary } from '../services/statisticsService';
import { sendSuccess, sendError } from '../utils/response';
import type { StatisticsSummaryQuery } from '../validators/statistics';

export async function summary(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as StatisticsSummaryQuery;

    const data = await getStatisticsSummary(tenantId, query.startDate, query.endDate);
    sendSuccess(res, data, 'Statistics summary retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve statistics summary', 500, err);
  }
}
