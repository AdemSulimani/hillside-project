import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { ensureOnboarded } from '../middleware/ensureOnboarded';
import { validateBody, validateQuery, validateParams } from '../middleware/validate';
import { uploadProductImages, uploadDocument, uploadOcrImage } from '../middleware/upload';
import {
  createProductSchema,
  updateProductSchema,
  productQuerySchema,
  productIdSchema,
} from '../validators/product';
import * as productController from '../controllers/productController';
import * as productImageController from '../controllers/productImageController';

const router = Router();

router.use(authenticate);
router.use(ensureOnboarded);

router.get('/', validateQuery(productQuerySchema), productController.index);
router.get('/tags', productController.getTags);
router.post('/', validateBody(createProductSchema), productController.store);
router.post('/upload/document', uploadDocument, productController.uploadDocument);
router.post('/upload/image', uploadOcrImage, productController.uploadOcrImage);

router.delete('/all', productController.destroyAll);

router.get('/:id', validateParams(productIdSchema), productController.show);
router.put('/:id', validateParams(productIdSchema), validateBody(updateProductSchema), productController.update);
router.delete('/:id', validateParams(productIdSchema), productController.destroy);

router.post('/:id/images', validateParams(productIdSchema), uploadProductImages, productImageController.upload);

export default router;
