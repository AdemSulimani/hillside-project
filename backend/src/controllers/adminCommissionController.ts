import type { Request, Response } from 'express';
import { findTenantById } from '../db/models/tenant';
import {
  listCommissionReportsForTenant,
  createCommissionReport,
  listAllCommissionReportsPage,
  updateCommissionReportStatusById,
  deleteCommissionReportById,
  findCommissionReportById,
  findCommissionReportByTenantAndPeriod,
} from '../db/models/commissionReport';
import {
  findOrderById,
  updateOrderCommissionStatusById,
} from '../db/models/order';
import pool from '../db/pool';
import {
  listAiUseCasesForAdmin,
  adminVoidAiUseCase,
  markUseCasesBilledInPeriod,
  markUseCasesPaidInPeriod,
  countAiUseCasesForTenantInPeriod,
  findAllCompletedUseCaseIdsForTenantInPeriod,
  stampBillingPeriodOnUseCases,
} from '../db/models/aiUseCase';
import { updateAdminUseCaseBillingStatus } from '../services/aiUseCaseService';
import { calculateProgressiveFee } from '../services/aiUseCaseService';
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
  getTenantUseCasePeriodStats,
} from '../services/platformCommissionService';
import { syncUnderlyingBillingForReportStatus } from '../services/billingReportSyncService';
import { sendSuccess, sendError, sendPaginated } from '../utils/response';
import type {
  AdminBusinessListQuery,
  AdminCommissionableOrdersQuery,
  AdminGenerateReportBody,
  AdminCommissionStatusPatchBody,
  AdminPeriodQueryRequired,
  AdminMarkCommissionPeriodBody,
  AdminReportStatusPatchBody,
  AdminUseCaseIdParamsBody,
  AdminUseCaseBillingStatusPatchBody,
  AdminMarkUseCasePeriodBody,
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

    const periodStart = parseDateOnlyUtc(body.period_start);
    const periodEnd = parseDateOnlyUtc(body.period_end);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sync = await syncUnderlyingBillingForReportStatus(
        tenantId,
        periodStart,
        periodEnd,
        'billed',
        client,
      );
      const report = await findCommissionReportByTenantAndPeriod(tenantId, periodStart, periodEnd, client);
      if (report) {
        await updateCommissionReportStatusById(report.id, 'billed', client);
      }
      await client.query('COMMIT');
      sendSuccess(
        res,
        { updated_count: sync.orders_updated, use_cases_updated: sync.use_cases_updated },
        'Orders marked as billed for the selected period',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

    const periodStart = parseDateOnlyUtc(body.period_start);
    const periodEnd = parseDateOnlyUtc(body.period_end);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const sync = await syncUnderlyingBillingForReportStatus(
        tenantId,
        periodStart,
        periodEnd,
        'paid',
        client,
      );
      const report = await findCommissionReportByTenantAndPeriod(tenantId, periodStart, periodEnd, client);
      if (report) {
        await updateCommissionReportStatusById(report.id, 'paid', client);
      }
      await client.query('COMMIT');
      sendSuccess(
        res,
        { updated_count: sync.orders_updated, use_cases_updated: sync.use_cases_updated },
        'Orders marked as paid for the selected period',
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    sendError(res, 'Failed to mark orders as paid', 500, err);
  }
}

export async function patchCommissionReport(req: Request, res: Response): Promise<void> {
  try {
    const { reportId } = (req.validated?.params ?? req.params) as { reportId: string };
    const { status } = req.body as AdminReportStatusPatchBody;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await findCommissionReportById(reportId, client);
      if (!existing) {
        await client.query('ROLLBACK');
        sendError(res, 'Commission report not found', 404);
        return;
      }

      if (existing.status !== status) {
        await syncUnderlyingBillingForReportStatus(
          existing.tenant_id,
          existing.period_start,
          existing.period_end,
          status,
          client,
        );
      }

      const updated = await updateCommissionReportStatusById(reportId, status, client);
      if (!updated) {
        await client.query('ROLLBACK');
        sendError(res, 'Commission report not found', 404);
        return;
      }

      await client.query('COMMIT');
      sendSuccess(res, { report: updated }, 'Commission report updated successfully');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

export async function listBusinessUseCases(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const query = (req.validated?.query ?? req.query) as unknown as AdminBusinessListQuery;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const { rows, total } = await listAiUseCasesForAdmin(tenantId, query.page, query.limit);
    sendPaginated(res, rows, query.page, query.limit, total, 'AI use cases retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to list AI use cases', 500, err);
  }
}

export async function patchUseCaseBillingStatus(req: Request, res: Response): Promise<void> {
  try {
    const { useCaseId } = (req.validated?.params ?? req.params) as AdminUseCaseIdParamsBody;
    const { billing_status } = req.body as AdminUseCaseBillingStatusPatchBody;

    const updated = await updateAdminUseCaseBillingStatus(useCaseId, billing_status);
    if (!updated) {
      sendError(res, 'AI use case not found', 404);
      return;
    }

    sendSuccess(res, { use_case: updated }, 'Use case billing status updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update use case billing status', 500, err);
  }
}

export async function voidUseCase(req: Request, res: Response): Promise<void> {
  try {
    const { useCaseId } = (req.validated?.params ?? req.params) as AdminUseCaseIdParamsBody;

    const voided = await adminVoidAiUseCase(useCaseId);
    if (!voided) {
      sendError(res, 'Use case not found or already billed/voided', 404);
      return;
    }

    sendSuccess(res, { use_case: voided }, 'Use case voided successfully');
  } catch (err) {
    sendError(res, 'Failed to void use case', 500, err);
  }
}

export async function businessUseCasePeriodStats(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const q = (req.validated?.query ?? req.query) as unknown as AdminPeriodQueryRequired;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const { start, endExclusive } = periodToUtcRange(q.period_start, q.period_end);
    const stats = await getTenantUseCasePeriodStats(tenantId, start, endExclusive);
    sendSuccess(res, stats, 'Use case period stats retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to load use case period stats', 500, err);
  }
}

export async function markUseCasesBilledForPeriod(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const body = req.body as AdminMarkUseCasePeriodBody;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const updatedCount = await markUseCasesBilledInPeriod(tenantId, body.billing_period);
    sendSuccess(res, { updated_count: updatedCount }, 'Use cases marked as billed');
  } catch (err) {
    sendError(res, 'Failed to mark use cases as billed', 500, err);
  }
}

export async function markUseCasesPaidForPeriod(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const body = req.body as AdminMarkUseCasePeriodBody;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    const updatedCount = await markUseCasesPaidInPeriod(tenantId, body.billing_period);
    sendSuccess(res, { updated_count: updatedCount }, 'Use cases marked as paid');
  } catch (err) {
    sendError(res, 'Failed to mark use cases as paid', 500, err);
  }
}

/**
 * Manually stamps billing_period and fee_amount on ALL completed use cases for a tenant
 * resolved within the given billing period (YYYY-MM). Recalculates the progressive fee
 * from scratch using the full case count, so repeated calls are idempotent.
 *
 * This replicates the month-end billing job logic on demand, letting admins trigger
 * fee calculation without waiting for the scheduled cron.
 */
export async function stampUseCaseFees(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = (req.validated?.params ?? req.params) as { tenantId: string };
    const body = req.body as AdminMarkUseCasePeriodBody;

    const tenant = await findTenantById(tenantId);
    if (!tenant) {
      sendError(res, 'Business not found', 404);
      return;
    }

    // Derive the UTC date range from the YYYY-MM billing period string.
    const [yearStr, monthStr] = body.billing_period.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10) - 1; // 0-indexed
    if (!Number.isFinite(year) || !Number.isFinite(month)) {
      sendError(res, 'Invalid billing_period format — expected YYYY-MM', 400);
      return;
    }
    const rangeStart = new Date(Date.UTC(year, month, 1));
    const rangeEnd = new Date(Date.UTC(year, month + 1, 1));

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ids = await findAllCompletedUseCaseIdsForTenantInPeriod(
        tenantId,
        rangeStart,
        rangeEnd,
        client,
      );

      if (ids.length === 0) {
        await client.query('ROLLBACK');
        sendSuccess(
          res,
          { stamped_count: 0, total_fee: 0, fee_per_case: 0 },
          'No completed use cases found in this billing period',
        );
        return;
      }

      const totalFee = calculateProgressiveFee(ids.length);
      const feePerCase = Math.round((totalFee / ids.length) * 100) / 100;

      await stampBillingPeriodOnUseCases(ids, body.billing_period, feePerCase, client);

      await client.query('COMMIT');

      sendSuccess(
        res,
        { stamped_count: ids.length, total_fee: totalFee, fee_per_case: feePerCase },
        `Stamped fees for ${ids.length} use case(s) in ${body.billing_period}`,
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    sendError(res, 'Failed to stamp use case fees', 500, err);
  }
}

export async function generateFullReport(req: Request, res: Response): Promise<void> {
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
    const { start, endExclusive } = periodToUtcRange(body.period_start, body.period_end);

    const [agg, reportStatus, useCaseCount] = await Promise.all([
      aggregateReportForTenantInPeriod(tenantId, periodStart, periodEnd),
      deriveCommissionReportStatusForTenantPeriod(tenantId, periodStart, periodEnd),
      countAiUseCasesForTenantInPeriod(tenantId, start, endExclusive),
    ]);

    const useCaseAmount = calculateProgressiveFee(useCaseCount);

    const report = await createCommissionReport({
      tenant_id: tenantId,
      period_start: periodStart,
      period_end: periodEnd,
      total_orders: agg.total_orders,
      total_revenue: agg.total_revenue,
      commission_amount: agg.commission_amount,
      use_case_count: useCaseCount,
      use_case_amount: useCaseAmount,
      status: reportStatus,
    });

    sendSuccess(res, { report }, 'Full billing report generated successfully', 201);
  } catch (err) {
    sendError(res, 'Failed to generate full billing report', 500, err);
  }
}
