import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import * as creditsController from '../controllers/creditsController';

const router = Router();

router.use(authenticate, ensureOnboarded);

router.get('/summary', creditsController.summary);
router.get('/use-cases', creditsController.useCases);
router.get('/monthly-breakdown', creditsController.monthlyBreakdown);
router.get('/billing-history', creditsController.billingHistory);
router.get('/tier-status', creditsController.tierStatus);
router.get('/daily-volume', creditsController.dailyUseCaseVolume);

export default router;
