import type { Request, Response } from 'express';
import { getQueuesHealth } from '../services/queueHealthService';
import { sendSuccess, sendError } from '../utils/response';

export async function queues(_req: Request, res: Response): Promise<void> {
  try {
    const data = await getQueuesHealth();
    sendSuccess(res, data, 'Queue health retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to read queue health', 500, err);
  }
}
