import { Router } from 'express';
import { verifyMetaWebhook } from '../controllers/webhookVerificationController';
import { ingestWebhook } from '../controllers/webhookController';

const router = Router();

router.get('/meta', verifyMetaWebhook);
router.get('/:channelType', verifyMetaWebhook);
router.post('/:channelType', ingestWebhook);

export default router;
