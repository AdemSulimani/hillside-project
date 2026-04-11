import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateQuery } from '../middleware/validate';
import * as statisticsController from '../controllers/statisticsController';
import { statisticsSummaryQuerySchema } from '../validators/statistics';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/summary', validateQuery(statisticsSummaryQuerySchema), statisticsController.summary);

export default router;
