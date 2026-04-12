import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import * as chatbotControlController from '../controllers/chatbotControlController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/status', chatbotControlController.globalStatus);
router.patch('/toggle', chatbotControlController.toggleGlobal);
router.get('/paused-conversations', chatbotControlController.pausedConversations);

export default router;
