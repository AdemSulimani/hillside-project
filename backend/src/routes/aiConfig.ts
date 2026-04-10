import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateBody } from '../middleware/validate';
import { updateAIConfigSchema, testAIConfigSchema } from '../validators/aiConfig';
import * as aiConfigController from '../controllers/aiConfigController';

const router = Router();

router.use(authenticate, ensureOnboarded);

router.get('/', aiConfigController.show);
router.put('/', validateBody(updateAIConfigSchema), aiConfigController.update);
router.post('/test', validateBody(testAIConfigSchema), aiConfigController.test);

export default router;
