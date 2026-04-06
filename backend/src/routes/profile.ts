import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateBody } from '../middleware/validate';
import { updateProfileSchema, updatePasswordSchema } from '../validators/profile';
import * as profileController from '../controllers/profileController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.put('/', validateBody(updateProfileSchema), profileController.update);
router.put('/password', validateBody(updatePasswordSchema), profileController.updatePassword);

export default router;
