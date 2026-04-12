import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validate, validateBody, validateParams, validateQuery } from '../middleware/validate';
import {
  aiAlertIdParamsSchema,
  aiAlertListQuerySchema,
  resolveAIAlertBodySchema,
} from '../validators/aiAlert';
import * as aiAlertController from '../controllers/aiAlertController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/unread-count', aiAlertController.unreadCount);
router.post('/mark-all-read', aiAlertController.markAllRead);
router.get('/', validateQuery(aiAlertListQuerySchema), aiAlertController.index);
router.patch(
  '/:id/read',
  validateParams(aiAlertIdParamsSchema),
  aiAlertController.markAsRead,
);
router.patch(
  '/:id/resolve',
  validate({ params: aiAlertIdParamsSchema, body: resolveAIAlertBodySchema }),
  aiAlertController.resolve,
);

export default router;
