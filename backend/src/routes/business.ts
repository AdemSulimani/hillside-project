import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateBody } from '../middleware/validate';
import { uploadLogo } from '../middleware/upload';
import { updateBusinessSchema } from '../validators/business';
import * as businessController from '../controllers/businessController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/', businessController.show);
router.put('/', validateBody(updateBusinessSchema), businessController.update);
router.post('/logo', uploadLogo, businessController.uploadLogo);

export default router;
