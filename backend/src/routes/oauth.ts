import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import * as metaOAuthController from '../controllers/metaOAuthController';
import * as instagramOAuthController from '../controllers/instagramOAuthController';

const router = Router();

router.get('/meta/redirect', authenticate, ensureOnboarded, metaOAuthController.redirect);
router.get('/meta/callback', metaOAuthController.callback);
router.get(
  '/instagram/redirect',
  authenticate,
  ensureOnboarded,
  instagramOAuthController.redirect,
);
router.get('/instagram/callback', instagramOAuthController.callback);

export default router;
