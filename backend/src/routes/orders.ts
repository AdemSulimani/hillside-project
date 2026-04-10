import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateBody, validateQuery, validateParams } from '../middleware/validate';
import {
  orderIdParamsSchema,
  orderListQuerySchema,
  updateDraftOrderBodySchema,
} from '../validators/order';
import * as orderController from '../controllers/orderController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/', validateQuery(orderListQuerySchema), orderController.index);
router.get('/:id', validateParams(orderIdParamsSchema), orderController.show);
router.patch(
  '/:id/confirm',
  validateParams(orderIdParamsSchema),
  orderController.confirm,
);
router.patch(
  '/:id/cancel',
  validateParams(orderIdParamsSchema),
  orderController.cancel,
);
router.put(
  '/:id',
  validateParams(orderIdParamsSchema),
  validateBody(updateDraftOrderBodySchema),
  orderController.update,
);

export default router;
