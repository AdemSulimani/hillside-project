import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateBody, validateQuery } from '../middleware/validate';
import { feedbackListQuerySchema, storeFeedbackBodySchema } from '../validators/feedback';
import * as feedbackController from '../controllers/feedbackController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.post('/', validateBody(storeFeedbackBodySchema), feedbackController.store);
router.get('/', validateQuery(feedbackListQuerySchema), feedbackController.index);

export default router;
