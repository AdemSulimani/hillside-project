import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validate, validateBody, validateParams, validateQuery } from '../middleware/validate';
import {
  contactIdParamsSchema,
  contactListQuerySchema,
  contactShowQuerySchema,
  updateContactBodySchema,
} from '../validators/contact';
import * as contactController from '../controllers/contactController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/', validateQuery(contactListQuerySchema), contactController.index);
router.get(
  '/:id',
  validate({ params: contactIdParamsSchema, query: contactShowQuerySchema }),
  contactController.show,
);
router.put(
  '/:id',
  validateParams(contactIdParamsSchema),
  validateBody(updateContactBodySchema),
  contactController.update,
);

export default router;
