import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { uploadLogo } from '../middleware/upload';
import * as onboardingController from '../controllers/onboardingController';

const router = Router();

router.use(authenticate);

router.post('/complete', uploadLogo, onboardingController.complete);
router.get('/status', onboardingController.status);

export default router;
