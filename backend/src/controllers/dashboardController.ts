import type { Request, Response } from 'express';
import pool from '../db/pool';
import { sendSuccess, sendError } from '../utils/response';

interface DashboardSummary {
  messagesToday: number;
  totalOrders: number;
  totalContacts: number;
  activeChannels: number;
}

async function safeCount(query: string, params: unknown[]): Promise<number> {
  try {
    const { rows } = await pool.query<{ count: string }>(query, params);
    return parseInt(rows[0].count, 10);
  } catch {
    return 0;
  }
}

export async function summary(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId;

    const [messagesToday, totalOrders, totalContacts, activeChannels] = await Promise.all([
      safeCount(
        `SELECT COUNT(*) FROM messages WHERE tenant_id = $1 AND created_at >= CURRENT_DATE`,
        [tenantId],
      ),
      safeCount(
        `SELECT COUNT(*) FROM orders WHERE tenant_id = $1`,
        [tenantId],
      ),
      safeCount(
        `SELECT COUNT(*) FROM contacts WHERE tenant_id = $1`,
        [tenantId],
      ),
      safeCount(
        `SELECT COUNT(*) FROM channels WHERE tenant_id = $1 AND webhook_verified = true`,
        [tenantId],
      ),
    ]);

    const data: DashboardSummary = { messagesToday, totalOrders, totalContacts, activeChannels };

    sendSuccess(res, data, 'Dashboard summary retrieved');
  } catch (err) {
    sendError(res, 'Failed to retrieve dashboard summary', 500, err);
  }
}
