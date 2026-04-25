import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateQuery } from '../middleware/validate';
import { escalationListQuerySchema } from '../validators/escalation';
import * as escalationController from '../controllers/escalationController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/', validateQuery(escalationListQuerySchema), escalationController.index);

export default router;
