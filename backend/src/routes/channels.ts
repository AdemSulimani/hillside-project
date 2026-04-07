import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateBody, validateParams } from '../middleware/validate';
import { channelIdSchema, whatsappConnectSchema } from '../validators/channel';
import * as channelController from '../controllers/channelController';
import * as whatsAppController from '../controllers/whatsAppController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/', channelController.index);
router.delete('/:id', validateParams(channelIdSchema), channelController.destroy);
router.patch('/:id/toggle-ai', validateParams(channelIdSchema), channelController.toggleAI);
router.post('/whatsapp/connect', validateBody(whatsappConnectSchema), whatsAppController.connect);

export default router;
