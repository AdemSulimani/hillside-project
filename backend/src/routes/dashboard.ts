import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import * as dashboardController from '../controllers/dashboardController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/summary', dashboardController.summary);

export default router;
