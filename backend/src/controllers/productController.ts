import type { Request, Response } from 'express';
import pool from '../db/pool';
import {
  createProduct,
  findProductsByTenant,
  findProductById,
  updateProduct,
  softDeleteProduct,
  softDeleteAllProducts,
} from '../db/models/product';
import { sendSuccess, sendError, sendPaginated } from '../utils/response';
import { getDocumentService } from '../services/documents';
import { ImageProcessingService } from '../services/ImageProcessingService';
import { AIProductProcessingService } from '../services/AIProductProcessingService';
import { defaultQueue } from '../jobs/queues';
import type { CreateProductInput, UpdateProductInput } from '../validators/product';
import type { ProductQuery } from '../validators/product';
import { redisConnection } from '../jobs/redisConnection';
import { deleteImage, getPublicIdFromUrl } from '../services/cloudinaryService';

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as ProductQuery;

    const tags = query.tags
      ? query.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;

    const { products, total } = await findProductsByTenant({
      tenantId,
      search: query.search,
      tags,
      isActive: query.is_active,
      page: query.page,
      limit: query.limit,
    });

    sendPaginated(res, products, query.page, query.limit, total, 'Products retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve products', 500, err);
  }
}

export async function getTags(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { rows } = await pool.query<{ tag: string }>(
      `SELECT DISTINCT jsonb_array_elements_text(tags) AS tag
       FROM products
       WHERE tenant_id = $1
         AND deleted_at IS NULL
         AND is_active = true
       ORDER BY tag ASC`,
      [tenantId],
    );

    sendSuccess(
      res,
      { tags: rows.map((row) => row.tag) },
      'Product tags retrieved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to retrieve product tags', 500, err);
  }
}

export async function store(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const input = req.body as CreateProductInput;

    const product = await createProduct({
      tenant_id: tenantId,
      name: input.name,
      brand: input.brand ?? null,
      price: input.price,
      discounted_price: input.discounted_price ?? null,
      description: input.description ?? null,
      usage_description: input.usage_description ?? null,
      sku: input.sku ?? null,
      category: input.category ?? null,
      tags: input.tags,
      is_active: input.is_active,
      in_stock: input.in_stock ?? true,
      source_type: 'manual',
    });

    // Priority 1 = highest — live edits always run before bulk reconciliation jobs (priority 5).
    await defaultQueue.add('product.embedding', { productId: product.id, tenantId }, { priority: 1 });
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(res, { product }, 'Product created successfully', 201);
  } catch (err) {
    sendError(res, 'Failed to create product', 500, err);
  }
}

export async function show(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);

    const product = await findProductById(id, tenantId);
    if (!product) {
      sendError(res, 'Product not found', 404);
      return;
    }

    sendSuccess(res, { product }, 'Product retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve product', 500, err);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);
    const fields = req.body as UpdateProductInput;
    const fieldsWithImages = fields as UpdateProductInput & { image_urls?: string[] };

    const existing = await findProductById(id, tenantId);
    const product = await updateProduct(id, tenantId, fields);
    if (!product) {
      sendError(res, 'Product not found', 404);
      return;
    }

    if (existing && Array.isArray(fieldsWithImages.image_urls)) {
      const removedUrls = existing.image_urls.filter((url) => !fieldsWithImages.image_urls!.includes(url));
      for (const url of removedUrls) {
        try {
          await deleteImage(getPublicIdFromUrl(url));
        } catch (err) {
          console.warn('[products.update] Failed to delete Cloudinary image', { url, err });
        }
      }
    }

    // usage_description was previously missing from this list — any update to it would
    // leave the embedding pointing at the old text, silently breaking "how do I use X?"
    // semantic queries. All fields that feed buildProductText() must be listed here.
    const embeddingRelevantFields = ['name', 'brand', 'description', 'tags', 'category', 'usage_description'] as const;
    const touchesEmbedding = embeddingRelevantFields.some(
      (f) => f in fields,
    );
    if (touchesEmbedding) {
      // Priority 1 = highest — live edits always run before bulk reconciliation (priority 5).
      await defaultQueue.add('product.embedding', { productId: product.id, tenantId }, { priority: 1 });
    }
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(res, { product }, 'Product updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update product', 500, err);
  }
}

export async function destroyAll(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { deletedCount, imageUrls } = await softDeleteAllProducts(tenantId);

    if (deletedCount === 0) {
      sendSuccess(res, { deletedCount: 0 }, 'No products to delete');
      return;
    }

    for (const url of imageUrls) {
      try {
        await deleteImage(getPublicIdFromUrl(url));
      } catch (err) {
        console.warn('[products.destroyAll] Failed to delete Cloudinary image', { url, err });
      }
    }
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(
      res,
      { deletedCount },
      `${deletedCount} product(s) deleted successfully`,
    );
  } catch (err) {
    sendError(res, 'Failed to delete products', 500, err);
  }
}

export async function destroy(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);

    const existing = await findProductById(id, tenantId);
    const deleted = await softDeleteProduct(id, tenantId);
    if (!deleted) {
      sendError(res, 'Product not found', 404);
      return;
    }
    if (existing) {
      for (const url of existing.image_urls) {
        try {
          await deleteImage(getPublicIdFromUrl(url));
        } catch (err) {
          console.warn('[products.destroy] Failed to delete Cloudinary image', { url, err });
        }
      }
    }
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(res, null, 'Product deleted successfully');
  } catch (err) {
    sendError(res, 'Failed to delete product', 500, err);
  }
}

export async function uploadDocument(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;

    if (!req.file) {
      sendError(res, 'No document file provided', 400);
      return;
    }

    const useAI = req.body.use_ai === 'true' || req.body.use_ai === true;
    const service = getDocumentService(tenantId, req.file.mimetype, req.file.originalname);
    const inputSource = req.file.buffer ?? req.file.path;
    if (!inputSource) {
      sendError(res, 'Uploaded document has no readable content', 400);
      return;
    }

    let products;
    if (useAI) {
      try {
        const aiService = new AIProductProcessingService();
        products = await service.processAndEnrich(
          inputSource,
          aiService.createEnricher(),
        );
      } catch {
        products = await service.process(inputSource);
      }
    } else {
      products = await service.process(inputSource);
    }

    // Queue embedding generation for every imported product. The document service
    // calls createProduct() directly (bypassing the single-product controller), so
    // embeddings are never scheduled otherwise — leaving all bulk-imported products
    // with embedding = NULL and invisible to semantic search.
    // Priority 2 — higher than reconciliation (5) but slightly below live edits (1).
    await Promise.all(
      products.map((p) =>
        defaultQueue.add('product.embedding', { productId: p.id, tenantId }, { priority: 2 }),
      ),
    );
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(
      res,
      { products, count: products.length },
      `${products.length} product(s) imported from document`,
      201,
    );
  } catch (err) {
    sendError(res, 'Failed to process document', 500, err);
  }
}

export async function uploadOcrImage(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;

    if (!req.file) {
      sendError(res, 'No image file provided', 400);
      return;
    }

    const useAI = req.body.use_ai === 'true' || req.body.use_ai === true;
    const imageService = new ImageProcessingService(tenantId);
    const inputSource = req.file.buffer ?? req.file.path;
    if (!inputSource) {
      sendError(res, 'Uploaded image has no readable content', 400);
      return;
    }

    let product;
    if (useAI) {
      try {
        const aiService = new AIProductProcessingService();
        product = await imageService.processWithAI(
          inputSource,
          aiService.createEnricher(),
        );
      } catch {
        product = await imageService.process(inputSource);
      }
    } else {
      product = await imageService.process(inputSource);
    }

    // Queue embedding generation — OCR image import calls createProduct() directly,
    // bypassing the single-product controller that normally enqueues this job.
    // Priority 2 — higher than reconciliation (5) but slightly below live edits (1).
    await defaultQueue.add('product.embedding', { productId: product.id, tenantId }, { priority: 2 });
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(res, { product }, 'Product imported from image', 201);
  } catch (err) {
    sendError(res, 'Failed to process image', 500, err);
  }
}
