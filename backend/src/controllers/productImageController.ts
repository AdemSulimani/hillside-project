import type { Request, Response } from 'express';
import { findProductById, appendImageUrls } from '../db/models/product';
import { sendSuccess, sendError } from '../utils/response';

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

    const newUrls = files.map((f) => `/uploads/${f.filename}`);
    const updated = await appendImageUrls(id, tenantId, newUrls);

    sendSuccess(
      res,
      { product: updated, added_urls: newUrls },
      `${newUrls.length} image(s) uploaded successfully`,
    );
  } catch (err) {
    sendError(res, 'Failed to upload product images', 500, err);
  }
}
