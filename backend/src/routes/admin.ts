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
  adminReportIdParamsSchema,
  adminReportStatusPatchBodySchema,
  adminUseCaseIdParamsSchema,
  adminUseCaseBillingStatusPatchBodySchema,
  adminMarkUseCasePeriodBodySchema,
} from '../validators/admin';
import {
  adminAiTestBodySchema,
  adminAiVersionIdParamsSchema,
  adminCatalogBlockIdParamsSchema,
  adminCreateCatalogBlockSchema,
  adminCreateCustomPromptBlockSchema,
  adminPatchTenantPromptBlockSchema,
  adminSyncAllCatalogBlocksBodySchema,
  adminTenantPromptBlockIdParamsSchema,
  adminUpdateCatalogBlockSchema,
  adminUpdateTenantAiConfigSchema,
} from '../validators/adminAi';
import * as adminTenantController from '../controllers/adminTenantController';
import * as adminAuthController from '../controllers/adminAuthController';
import * as adminCommissionController from '../controllers/adminCommissionController';
import * as adminAiController from '../controllers/adminAiController';

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
ownerRoutes.patch(
  '/commission-reports/:reportId',
  validateParams(adminReportIdParamsSchema),
  validateBody(adminReportStatusPatchBodySchema),
  adminCommissionController.patchCommissionReport,
);
ownerRoutes.delete(
  '/commission-reports/:reportId',
  validateParams(adminReportIdParamsSchema),
  adminCommissionController.destroyCommissionReport,
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

ownerRoutes.get(
  '/businesses/:tenantId/use-case-period-stats',
  validateParams(adminTenantIdParamsSchema),
  validateQuery(adminPeriodQueryRequiredSchema),
  adminCommissionController.businessUseCasePeriodStats,
);
ownerRoutes.get(
  '/businesses/:tenantId/use-cases',
  validateParams(adminTenantIdParamsSchema),
  validateQuery(adminBusinessListQuerySchema),
  adminCommissionController.listBusinessUseCases,
);
ownerRoutes.post(
  '/businesses/:tenantId/use-cases/stamp-fees',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminMarkUseCasePeriodBodySchema),
  adminCommissionController.stampUseCaseFees,
);
ownerRoutes.post(
  '/businesses/:tenantId/use-cases/mark-billed',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminMarkUseCasePeriodBodySchema),
  adminCommissionController.markUseCasesBilledForPeriod,
);
ownerRoutes.post(
  '/businesses/:tenantId/use-cases/mark-paid',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminMarkUseCasePeriodBodySchema),
  adminCommissionController.markUseCasesPaidForPeriod,
);
ownerRoutes.post(
  '/businesses/:tenantId/generate-full-report',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminGenerateReportBodySchema),
  adminCommissionController.generateFullReport,
);
ownerRoutes.patch(
  '/use-cases/:useCaseId/billing-status',
  validateParams(adminUseCaseIdParamsSchema),
  validateBody(adminUseCaseBillingStatusPatchBodySchema),
  adminCommissionController.patchUseCaseBillingStatus,
);
ownerRoutes.post(
  '/use-cases/:useCaseId/void',
  validateParams(adminUseCaseIdParamsSchema),
  adminCommissionController.voidUseCase,
);

ownerRoutes.get(
  '/businesses/:tenantId/ai/config',
  validateParams(adminTenantIdParamsSchema),
  adminAiController.getTenantAiConfig,
);
ownerRoutes.get(
  '/businesses/:tenantId/ai/prompt-blocks',
  validateParams(adminTenantIdParamsSchema),
  adminAiController.listTenantPromptBlocks,
);
ownerRoutes.put(
  '/businesses/:tenantId/ai/config',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminUpdateTenantAiConfigSchema),
  adminAiController.updateTenantAiConfig,
);
ownerRoutes.patch(
  '/businesses/:tenantId/ai/prompt-blocks/:blockRowId',
  validateParams(adminTenantPromptBlockIdParamsSchema),
  validateBody(adminPatchTenantPromptBlockSchema),
  adminAiController.patchTenantPromptBlock,
);
ownerRoutes.post(
  '/businesses/:tenantId/ai/prompt-blocks/:blockRowId/reset',
  validateParams(adminTenantPromptBlockIdParamsSchema),
  adminAiController.postTenantPromptBlockReset,
);
ownerRoutes.post(
  '/businesses/:tenantId/ai/prompt-blocks',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminCreateCustomPromptBlockSchema),
  adminAiController.postTenantPromptBlockCustom,
);
ownerRoutes.delete(
  '/businesses/:tenantId/ai/prompt-blocks/:blockRowId',
  validateParams(adminTenantPromptBlockIdParamsSchema),
  adminAiController.deleteTenantPromptBlockCustom,
);
ownerRoutes.get(
  '/businesses/:tenantId/ai/versions',
  validateParams(adminTenantIdParamsSchema),
  adminAiController.listTenantAiVersions,
);
ownerRoutes.post(
  '/businesses/:tenantId/ai/versions/:versionId/restore',
  validateParams(adminAiVersionIdParamsSchema),
  adminAiController.postRestoreTenantAiVersion,
);
ownerRoutes.post(
  '/businesses/:tenantId/ai/test',
  validateParams(adminTenantIdParamsSchema),
  validateBody(adminAiTestBodySchema),
  adminAiController.postTenantAiTest,
);
ownerRoutes.post(
  '/businesses/:tenantId/products/backfill-embeddings',
  validateParams(adminTenantIdParamsSchema),
  adminAiController.postBackfillProductEmbeddings,
);
ownerRoutes.post(
  '/businesses/:tenantId/products/reembed-all',
  validateParams(adminTenantIdParamsSchema),
  adminAiController.postReembedAllProducts,
);
ownerRoutes.post(
  '/businesses/:tenantId/products/backfill-image-fingerprints',
  validateParams(adminTenantIdParamsSchema),
  adminAiController.postBackfillProductImageFingerprints,
);
ownerRoutes.post(
  '/businesses/:tenantId/ai/sync-catalog-blocks',
  validateParams(adminTenantIdParamsSchema),
  adminAiController.postSyncTenantCatalogBlocks,
);
ownerRoutes.post(
  '/ai/sync-catalog-blocks',
  validateBody(adminSyncAllCatalogBlocksBodySchema),
  adminAiController.postSyncAllCatalogBlocks,
);

// Platform catalog block management
ownerRoutes.get('/ai/catalog-blocks', adminAiController.listCatalogBlocks);
ownerRoutes.post(
  '/ai/catalog-blocks',
  validateBody(adminCreateCatalogBlockSchema),
  adminAiController.createCatalogBlock,
);
ownerRoutes.patch(
  '/ai/catalog-blocks/:blockId',
  validateParams(adminCatalogBlockIdParamsSchema),
  validateBody(adminUpdateCatalogBlockSchema),
  adminAiController.updateCatalogBlock,
);

router.use(ownerRoutes);

router.delete(
  '/tenants/:tenantId',
  requireAdminKey,
  validateParams(adminTenantIdSchema),
  adminTenantController.destroyTenant,
);

export default router;
