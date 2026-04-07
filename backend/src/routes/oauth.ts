import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import * as metaOAuthController from '../controllers/metaOAuthController';

const router = Router();

router.get('/meta/redirect', authenticate, ensureOnboarded, metaOAuthController.redirect);
router.get('/meta/callback', metaOAuthController.callback);

export default router;
