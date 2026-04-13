import { Router } from 'express';
import { requireAdminKey } from '../middleware/requireAdminKey';
import { authenticateAdmin } from '../middleware/authenticateAdmin';
import { validateParams, validateBody, validateQuery } from '../middleware/validate';
import {
  adminTenantIdSchema,
  adminLoginBodySchema,
  adminBusinessListQuerySchema,
  adminTenantIdParamsSchema,
  adminCommissionableOrdersQuerySchema,
  adminOrderIdParamsSchema,
  adminCommissionStatusPatchBodySchema,
  adminGenerateReportBodySchema,
  adminMarkCommissionPeriodBodySchema,
  adminPeriodQueryRequiredSchema,
} from '../validators/admin';
import * as adminTenantController from '../controllers/adminTenantController';
import * as adminAuthController from '../controllers/adminAuthController';
import * as adminCommissionController from '../controllers/adminCommissionController';

const router = Router();

router.post('/auth/login', validateBody(adminLoginBodySchema), adminAuthController.login);

const ownerRoutes = Router();
ownerRoutes.use(authenticateAdmin);

ownerRoutes.get('/dashboard/summary', adminCommissionController.dashboardSummary);
ownerRoutes.get('/dashboard/commission-by-month', adminCommissionController.dashboardCommissionByMonth);
ownerRoutes.get(
  '/commission-reports',
  validateQuery(adminBusinessListQuerySchema),
  adminCommissionController.listCommissionReportsAll,
);
ownerRoutes.get(
  '/businesses',
  validateQuery(adminBusinessListQuerySchema),
  adminCommissionController.listBusinesses,
);
ownerRoutes.get(
  '/businesses/:tenantId/overview',
  validateParams(adminTenantIdParamsSchema),
  adminCommissionController.businessOverview,
);
ownerRoutes.get(
  '/businesses/:tenantId/period-stats',
  validateParams(adminTenantIdParamsSchema),
  validateQuery(adminPeriodQueryRequiredSchema),
  adminCommissionController.businessPeriodStats,
);
ownerRoutes.get(
  '/businesses/:tenantId/orders',
  validateParams(adminTenantIdParamsSchema),
  validateQuery(adminCommissionableOrdersQuerySchema),
  adminCommissionController.businessOrders,
);
ownerRoutes.get(
  '/businesses/:tenantId/commission-summary',
  validateParams(adminTenantIdParamsSchema),
  adminCommissionController.commissionSummary,
);
ownerRoutes.post(
  '/businesses/:tenantId/generate-report',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminGenerateReportBodySchema),
  adminCommissionController.generateReport,
);
ownerRoutes.post(
  '/businesses/:tenantId/mark-billed',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminMarkCommissionPeriodBodySchema),
  adminCommissionController.markBilledForPeriod,
);
ownerRoutes.post(
  '/businesses/:tenantId/mark-paid',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminMarkCommissionPeriodBodySchema),
  adminCommissionController.markPaidForPeriod,
);
ownerRoutes.patch(
  '/orders/:orderId/commission-status',
  validateParams(adminOrderIdParamsSchema),
  validateBody(adminCommissionStatusPatchBodySchema),
  adminCommissionController.patchOrderCommissionStatus,
);

router.use(ownerRoutes);

router.delete(
  '/tenants/:tenantId',
  requireAdminKey,
  validateParams(adminTenantIdSchema),
  adminTenantController.destroyTenant,
);

export default router;
