import { Router } from 'express';
import { requireAdminKey } from '../middleware/requireAdminKey';
import { validateParams } from '../middleware/validate';
import { adminTenantIdSchema } from '../validators/admin';
import * as adminTenantController from '../controllers/adminTenantController';

const router = Router();

router.use(requireAdminKey);

router.delete(
  '/tenants/:tenantId',
  validateParams(adminTenantIdSchema),
  adminTenantController.destroyTenant,
);

export default router;
