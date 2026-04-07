import { Router } from 'express';
import { verifyMetaWebhook } from '../controllers/webhookVerificationController';

const router = Router();

router.get('/meta', verifyMetaWebhook);

export default router;
