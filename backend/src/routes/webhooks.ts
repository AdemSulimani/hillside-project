import { Router } from 'express';
import { verifyMetaWebhook } from '../controllers/webhookVerificationController';
import { ingestWebhook } from '../controllers/webhookController';
import { ingestViberWebhook } from '../controllers/viberWebhookController';

const router = Router();

router.get('/meta', verifyMetaWebhook);
router.get('/:channelType', verifyMetaWebhook);

// Viber uses per-channel webhook URLs (identified by DB channel UUID) because each bot
// has its own auth token used for HMAC signature verification. This route must be
// registered before the generic /:channelType route to avoid a naming clash.
router.post('/viber/:channelId', ingestViberWebhook);
router.post('/:channelType', ingestWebhook);

export default router;
