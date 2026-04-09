import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validate, validateBody, validateParams, validateQuery } from '../middleware/validate';
import {
  conversationListQuerySchema,
  conversationIdSchema,
  conversationMessagesQuerySchema,
  conversationReplyBodySchema,
} from '../validators/conversation';
import * as conversationController from '../controllers/conversationController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/unread-count', conversationController.unreadCount);
router.get('/', validateQuery(conversationListQuerySchema), conversationController.index);
router.get(
  '/:id',
  validate({ params: conversationIdSchema, query: conversationMessagesQuerySchema }),
  conversationController.show,
);
router.post(
  '/:id/reply',
  validateParams(conversationIdSchema),
  validateBody(conversationReplyBodySchema),
  conversationController.reply,
);
router.patch('/:id/close', validateParams(conversationIdSchema), conversationController.close);
router.patch('/:id/reopen', validateParams(conversationIdSchema), conversationController.reopen);

export default router;
