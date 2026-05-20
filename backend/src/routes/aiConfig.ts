import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import * as aiConfigController from '../controllers/aiConfigController';

const router = Router();

router.use(authenticate, ensureOnboarded);

router.get('/', aiConfigController.show);
router.put('/', aiConfigController.update);
router.post('/test', aiConfigController.test);

export default router;
