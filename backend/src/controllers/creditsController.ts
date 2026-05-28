import type { Request, Response } from 'express';
import { sendSuccess, sendError, sendPaginated } from '../utils/response';
import {
  getCreditsSummaryForTenant,
  getMonthlyBreakdownForTenant,
  getDailyUseCaseVolumeForTenant,
  getBillingHistoryForTenant,
} from '../services/creditsService';
import { getTierStatusForTenant } from '../services/aiUseCaseService';
import { listAiUseCasesForTenant } from '../db/models/aiUseCase';

function parsePaginationQuery(query: Record<string, unknown>) {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10) || 20));
  return { page, limit };
}

export async function summary(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const data = await getCreditsSummaryForTenant(tenantId);
    sendSuccess(res, data, 'Credits summary retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load credits summary', 500, err);
  }
}

export async function useCases(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { page, limit } = parsePaginationQuery(req.query as Record<string, unknown>);
    const period = typeof req.query.period === 'string' ? req.query.period : null;

    const { rows, total } = await listAiUseCasesForTenant(tenantId, page, limit, period);
    sendPaginated(res, rows, page, limit, total, 'AI use cases retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to list AI use cases', 500, err);
  }
}

export async function monthlyBreakdown(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const series = await getMonthlyBreakdownForTenant(tenantId, 12);
    sendSuccess(res, { series }, 'Monthly breakdown retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load monthly breakdown', 500, err);
  }
}

export async function billingHistory(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { page, limit } = parsePaginationQuery(req.query as Record<string, unknown>);
    const { rows, total } = await getBillingHistoryForTenant(tenantId, page, limit);
    sendPaginated(res, rows, page, limit, total, 'Billing history retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load billing history', 500, err);
  }
}

export async function tierStatus(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const data = await getTierStatusForTenant(tenantId);
    sendSuccess(res, data, 'Tier status retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load tier status', 500, err);
  }
}

export async function dailyUseCaseVolume(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const series = await getDailyUseCaseVolumeForTenant(tenantId);
    sendSuccess(res, { series }, 'Daily use case volume retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load daily use case volume', 500, err);
  }
}
