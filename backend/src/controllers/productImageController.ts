import type { Request, Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import { findProductById, appendImageUrls } from '../db/models/product';
import { deleteFingerprintsForImageUrls } from '../db/models/productImageFingerprint';
import { sendSuccess, sendError } from '../utils/response';
import { uploadImage } from '../services/cloudinaryService';
import { defaultQueue } from '../jobs/queues';
import { invalidateProductCatalogCaches } from '../services/catalogGuardReferenceService';
import { queueProductImageFingerprintJobs } from '../services/productImageFingerprintService';

export async function upload(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);

    const product = await findProductById(id, tenantId);
    if (!product) {
      sendError(res, 'Product not found', 404);
      return;
    }

    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || files.length === 0) {
      sendError(res, 'No image files provided', 400);
      return;
    }

    const currentCount = Array.isArray(product.image_urls) ? product.image_urls.length : 0;
    if (currentCount + files.length > 20) {
      sendError(res, `Product already has ${currentCount} images. Maximum is 20.`, 400);
      return;
    }

    const newUrls = await Promise.all(
      files.map((file) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const uniqueFilename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
        return uploadImage(file.buffer, 'products', uniqueFilename);
      }),
    );
    const updated = await appendImageUrls(id, tenantId, newUrls);

    await queueProductImageFingerprintJobs(defaultQueue, id, tenantId, newUrls, 1);

    // Keep the tenant's fallback product cache consistent so the new images are
    // reflected immediately (mirrors productController.invalidateProductCaches).
    try {
      await invalidateProductCatalogCaches(tenantId);
    } catch (err) {
      console.warn('[productImages.upload] Failed to invalidate product cache', { tenantId, err });
    }

    sendSuccess(
      res,
      { product: updated, added_urls: newUrls },
      `${newUrls.length} image(s) uploaded successfully`,
    );
  } catch (err) {
    sendError(res, 'Failed to upload product images', 500, err);
  }
}
