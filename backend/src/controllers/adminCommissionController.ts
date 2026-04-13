import type { Request, Response } from 'express';
import { findTenantById } from '../db/models/tenant';
import {
  listCommissionReportsForTenant,
  createCommissionReport,
  listAllCommissionReportsPage,
  updateCommissionReportStatusById,
  deleteCommissionReportById,
} from '../db/models/commissionReport';
import {
  findOrderById,
  updateOrderCommissionStatusById,
  markOrdersCommissionBilledInPeriod,
  markOrdersCommissionPaidInPeriod,
} from '../db/models/order';
import { listChannelSummariesForTenant } from '../db/models/channel';
import {
  getAdminDashboardSummary,
  listAdminBusinessesPage,
  listCommissionableOrdersForTenant,
  getTenantCommissionSummary,
  aggregateReportForTenantInPeriod,
  deriveCommissionReportStatusForTenantPeriod,
  getCommissionEarnedByMonthUtc,
  getTenantCommissionPeriodStats,
} from '../services/platformCommissionService';
import { sendSuccess, sendError, sendPaginated } from '../utils/response';
import type {
  AdminBusinessListQuery,
  AdminCommissionableOrdersQuery,
  AdminGenerateReportBody,
  AdminCommissionStatusPatchBody,
  AdminPeriodQueryRequired,
  AdminMarkCommissionPeriodBody,
  AdminReportStatusPatchBody,
} from '../validators/admin';

function utcMonthBounds(reference: Date): { start: Date; endExclusive: Date } {
  const y = reference.getUTCFullYear();
  const m = reference.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const endExclusive = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0));
  return { start, endExclusive };
}

function periodToUtcRange(periodStart: string, periodEnd: string): { start: Date; endExclusive: Date } {
  const start = new Date(`${periodStart}T00:00:00.000Z`);
  const lastDay = new Date(`${periodEnd}T00:00:00.000Z`);
  const endExclusive = new Date(lastDay.getTime() + 86400000);
  return { start, endExclusive };
}

function parseDateOnlyUtc(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export async function dashboardSummary(_req: Request, res: Response): Promise<void> {
  try {
    const summary = await getAdminDashboardSummary();
    sendSuccess(res, summary, 'Dashboard summary retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load dashboard summary', 500, err);
  }
}

export async function dashboardCommissionByMonth(_req: Request, res: Response): Promise<void> {
  try {
    const series = await getCommissionEarnedByMonthUtc(12);
    sendSuccess(res, { series }, 'Commission series retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load commission chart data', 500, err);
  }
}

export async function listCommissionReportsAll(req: Request, res: Response): Promise<void> {
  try {
    const query = (req.validated?.query ?? req.query) as unknown as AdminBusinessListQuery;
    const { rows, total } = await listAllCommissionReportsPage(query.page, query.limit);
    sendPaginated(res, rows, query.page, query.limit, total, 'Commission reports retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to list commission reports', 500, err);
  }
}

export async function listBusinesses(req: Request, res: Response): Promise<void> {
  try {
    const query = (req.validated?.query ?? req.query) as unknown as AdminBusinessListQuery;
    const { rows, total } = await listAdminBusinessesPage(query.page, query.limit);
    sendPaginated(res, rows, query.page, query.limit, total, 'Businesses retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to list businesses', 500, err);
  }
}

export async function businessOverview(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const channels = await listChannelSummariesForTenant(tenantId);
    sendSuccess(res, { tenant, channels }, 'Business overview retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load business overview', 500, err);
  }
}

export async function businessPeriodStats(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const q = (req.validated?.query ?? req.query) as unknown as AdminPeriodQueryRequired;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const { start, endExclusive } = periodToUtcRange(q.period_start, q.period_end);
    const stats = await getTenantCommissionPeriodStats(tenantId, start, endExclusive);
    sendSuccess(res, stats, 'Period stats retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load period stats', 500, err);
  }
}

export async function businessOrders(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const query = (req.validated?.query ?? req.query) as unknown as AdminCommissionableOrdersQuery;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const dateRange =
      query.period_start && query.period_end
        ? (() => {
            const { start, endExclusive } = periodToUtcRange(query.period_start, query.period_end);
            return { rangeStartInclusive: start, rangeEndExclusive: endExclusive };
          })()
        : null;

    const { orders, total } = await listCommissionableOrdersForTenant(
      tenantId,
      query.page,
      query.limit,
      dateRange,
    );
    sendPaginated(res, orders, query.page, query.limit, total, 'Commissionable orders retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to list commissionable orders', 500, err);
  }
}

export async function commissionSummary(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const { start, endExclusive } = utcMonthBounds(new Date());
    const summary = await getTenantCommissionSummary(tenantId, start, endExclusive);
    if (!summary) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const commission_history = await listCommissionReportsForTenant(tenantId);

    sendSuccess(
      res,
      {
        ...summary,
        commission_history,
      },
      'Commission summary retrieved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to load commission summary', 500, err);
  }
}

export async function patchOrderCommissionStatus(req: Request, res: Response): Promise<void> {
  try {
    const { orderId } = (req.validated?.params ?? req.params) as { orderId: string };
    const { commission_status } = req.body as AdminCommissionStatusPatchBody;

    const existing = await findOrderById(orderId);
    if (!existing) {
      sendError(res, 'Order not found', 404);
      return;
    }
    if (!existing.is_commissionable) {
      sendError(res, 'This order is not commissionable', 400);
      return;
    }

    const updated = await updateOrderCommissionStatusById(orderId, commission_status);
    if (!updated) {
      sendError(res, 'Failed to update commission status', 500);
      return;
    }

    sendSuccess(res, { order: updated }, 'Commission status updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update commission status', 500, err);
  }
}

export async function generateReport(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const body = req.body as AdminGenerateReportBody;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const periodStart = parseDateOnlyUtc(body.period_start);
    const periodEnd = parseDateOnlyUtc(body.period_end);

    const agg = await aggregateReportForTenantInPeriod(tenantId, periodStart, periodEnd);
    const reportStatus = await deriveCommissionReportStatusForTenantPeriod(
      tenantId,
      periodStart,
      periodEnd,
    );

    const report = await createCommissionReport({
      tenant_id: tenantId,
      period_start: periodStart,
      period_end: periodEnd,
      total_orders: agg.total_orders,
      total_revenue: agg.total_revenue,
      commission_amount: agg.commission_amount,
      status: reportStatus,
    });

    sendSuccess(res, { report }, 'Commission report generated successfully', 201);
  } catch (err) {
    sendError(res, 'Failed to generate commission report', 500, err);
  }
}

export async function markBilledForPeriod(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const body = req.body as AdminMarkCommissionPeriodBody;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const { start, endExclusive } = periodToUtcRange(body.period_start, body.period_end);
    const updatedCount = await markOrdersCommissionBilledInPeriod(tenantId, start, endExclusive);
    sendSuccess(res, { updated_count: updatedCount }, 'Orders marked as billed for the selected period');
  } catch (err) {
    sendError(res, 'Failed to mark orders as billed', 500, err);
  }
}

export async function markPaidForPeriod(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const body = req.body as AdminMarkCommissionPeriodBody;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const { start, endExclusive } = periodToUtcRange(body.period_start, body.period_end);
    const updatedCount = await markOrdersCommissionPaidInPeriod(tenantId, start, endExclusive);
    sendSuccess(res, { updated_count: updatedCount }, 'Orders marked as paid for the selected period');
  } catch (err) {
    sendError(res, 'Failed to mark orders as paid', 500, err);
  }
}

export async function patchCommissionReport(req: Request, res: Response): Promise<void> {
  try {
    const { reportId } = (req.validated?.params ?? req.params) as { reportId: string };
    const { status } = req.body as AdminReportStatusPatchBody;

    const updated = await updateCommissionReportStatusById(reportId, status);
    if (!updated) {
      sendError(res, 'Commission report not found', 404);
      return;
    }

    sendSuccess(res, { report: updated }, 'Commission report updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update commission report', 500, err);
  }
}

export async function destroyCommissionReport(req: Request, res: Response): Promise<void> {
  try {
    const { reportId } = (req.validated?.params ?? req.params) as { reportId: string };

    const deleted = await deleteCommissionReportById(reportId);
    if (!deleted) {
      sendError(res, 'Commission report not found', 404);
      return;
    }

    sendSuccess(res, { deleted: true }, 'Commission report deleted successfully');
  } catch (err) {
    sendError(res, 'Failed to delete commission report', 500, err);
  }
}
