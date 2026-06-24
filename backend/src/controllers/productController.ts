import type { Request, Response } from 'express';
import pool from '../db/pool';
import {
  createProduct,
  findProductsByTenant,
  findProductById,
  findConflictingProductIdByName,
  updateProduct,
  softDeleteProduct,
  softDeleteAllProducts,
  type Product,
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
import {
  deleteFingerprintsForImageUrls,
  deleteFingerprintsForProduct,
  deleteAllFingerprintsForTenant,
} from '../db/models/productImageFingerprint';
import {
  queueProductImageFingerprintJobs,
  invalidateImageFingerprintCache,
} from '../services/productImageFingerprintService';
import { isPgCheckViolation, isPgUniqueViolation, pgConstraintName } from '../utils/pgErrors';
import { repairOptionalUtf8Text } from '../utils/textEncoding';

function withRepairedTextFields<T extends Product>(product: T): T {
  return {
    ...product,
    name: repairOptionalUtf8Text(product.name) ?? product.name,
    brand: repairOptionalUtf8Text(product.brand),
    description: repairOptionalUtf8Text(product.description),
    usage_description: repairOptionalUtf8Text(product.usage_description),
    sku: repairOptionalUtf8Text(product.sku),
    category: repairOptionalUtf8Text(product.category),
    flavor: repairOptionalUtf8Text(product.flavor),
    size: repairOptionalUtf8Text(product.size),
    color: repairOptionalUtf8Text(product.color),
    variant: repairOptionalUtf8Text(product.variant),
    weight: repairOptionalUtf8Text(product.weight),
    tags: product.tags.map((tag) => repairOptionalUtf8Text(tag) ?? tag),
  };
}

function normalizeUpdateFields(fields: UpdateProductInput): UpdateProductInput {
  const normalized: UpdateProductInput = { ...fields };

  if ('name' in fields && fields.name !== undefined) {
    normalized.name = repairOptionalUtf8Text(fields.name) ?? fields.name;
  }
  if ('brand' in fields) normalized.brand = repairOptionalUtf8Text(fields.brand);
  if ('description' in fields) normalized.description = repairOptionalUtf8Text(fields.description);
  if ('usage_description' in fields) {
    normalized.usage_description = repairOptionalUtf8Text(fields.usage_description);
  }
  if ('sku' in fields) normalized.sku = repairOptionalUtf8Text(fields.sku);
  if ('category' in fields) normalized.category = repairOptionalUtf8Text(fields.category);
  if ('flavor' in fields) normalized.flavor = repairOptionalUtf8Text(fields.flavor);
  if ('size' in fields) normalized.size = repairOptionalUtf8Text(fields.size);
  if ('color' in fields) normalized.color = repairOptionalUtf8Text(fields.color);
  if ('variant' in fields) normalized.variant = repairOptionalUtf8Text(fields.variant);
  if ('weight' in fields) normalized.weight = repairOptionalUtf8Text(fields.weight);
  if ('tags' in fields && Array.isArray(fields.tags)) {
    normalized.tags = fields.tags.map((tag) => repairOptionalUtf8Text(tag) ?? tag);
  }

  return normalized;
}

function validateEffectivePricing(
  existing: Product | null,
  fields: UpdateProductInput,
): string | null {
  const effectivePrice = fields.price ?? existing?.price;
  const effectiveDiscounted =
    fields.discounted_price !== undefined ? fields.discounted_price : existing?.discounted_price;

  if (
    effectiveDiscounted != null &&
    effectivePrice != null &&
    effectiveDiscounted >= effectivePrice
  ) {
    return 'Discounted price must be lower than the regular price';
  }

  return null;
}

async function invalidateProductCaches(tenantId: string, productId: string, fields: UpdateProductInput): Promise<void> {
  const embeddingRelevantFields = [
    'name', 'brand', 'description', 'tags', 'category', 'usage_description',
    'flavor', 'size', 'color', 'variant', 'weight',
  ] as const;
  const touchesEmbedding = embeddingRelevantFields.some((f) => f in fields);

  try {
    if (touchesEmbedding) {
      await defaultQueue.add('product.embedding', { productId, tenantId }, { priority: 1 });
    }
    await redisConnection.del(`products:${tenantId}`);
  } catch (err) {
    console.warn('[products] Post-update cache/queue work failed; product row was saved', {
      tenantId,
      productId,
      err,
    });
  }
}

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

    sendPaginated(
      res,
      products.map(withRepairedTextFields),
      query.page,
      query.limit,
      total,
      'Products retrieved successfully',
    );
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
    const input = normalizeUpdateFields(req.body as CreateProductInput) as CreateProductInput;

    const conflictId = await findConflictingProductIdByName(tenantId, input.name);
    if (conflictId) {
      sendError(
        res,
        'A product with this name already exists in your catalog',
        409,
        { body: { name: ['A product with this name already exists in your catalog'] } },
      );
      return;
    }

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

    await invalidateProductCaches(tenantId, product.id, {
      name: product.name,
      description: product.description,
      tags: product.tags,
    });

    sendSuccess(res, { product: withRepairedTextFields(product) }, 'Product created successfully', 201);
  } catch (err) {
    if (isPgUniqueViolation(err) && pgConstraintName(err) === 'idx_products_tenant_name_unique') {
      sendError(
        res,
        'A product with this name already exists in your catalog',
        409,
        { body: { name: ['A product with this name already exists in your catalog'] } },
      );
      return;
    }

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

    sendSuccess(res, { product: withRepairedTextFields(product) }, 'Product retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve product', 500, err);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);
    const fields = normalizeUpdateFields(req.body as UpdateProductInput);

    const existing = await findProductById(id, tenantId);
    if (!existing) {
      sendError(res, 'Product not found', 404);
      return;
    }

    const pricingError = validateEffectivePricing(existing, fields);
    if (pricingError) {
      sendError(res, pricingError, 400, { body: { discounted_price: [pricingError] } });
      return;
    }

    if (fields.name !== undefined) {
      const conflictId = await findConflictingProductIdByName(tenantId, fields.name, id);
      if (conflictId) {
        sendError(
          res,
          'A product with this name already exists in your catalog',
          409,
          { body: { name: ['A product with this name already exists in your catalog'] } },
        );
        return;
      }
    }

    const product = await updateProduct(id, tenantId, fields);
    if (!product) {
      sendError(res, 'Product not found', 404);
      return;
    }

    if (Array.isArray(fields.image_urls)) {
      const removedUrls = existing.image_urls.filter((url) => !fields.image_urls!.includes(url));
      const addedUrls = fields.image_urls.filter((url) => !existing.image_urls.includes(url));
      for (const url of removedUrls) {
        try {
          await deleteImage(getPublicIdFromUrl(url));
        } catch (err) {
          console.warn('[products.update] Failed to delete Cloudinary image', { url, err });
        }
      }
      if (removedUrls.length > 0) {
        await deleteFingerprintsForImageUrls(tenantId, removedUrls);
        await invalidateImageFingerprintCache(tenantId, removedUrls);
      }
      if (addedUrls.length > 0) {
        try {
          await queueProductImageFingerprintJobs(defaultQueue, product.id, tenantId, addedUrls, 1);
        } catch (err) {
          console.warn('[products.update] Failed to queue image fingerprint jobs', { productId: product.id, err });
        }
      }
    }

    await invalidateProductCaches(tenantId, product.id, fields);

    sendSuccess(res, { product: withRepairedTextFields(product) }, 'Product updated successfully');
  } catch (err) {
    if (isPgUniqueViolation(err) && pgConstraintName(err) === 'idx_products_tenant_name_unique') {
      sendError(
        res,
        'A product with this name already exists in your catalog',
        409,
        { body: { name: ['A product with this name already exists in your catalog'] } },
      );
      return;
    }

    if (isPgCheckViolation(err) && pgConstraintName(err) === 'products_discounted_price_check') {
      sendError(
        res,
        'Discounted price must be lower than the regular price',
        400,
        { body: { discounted_price: ['Discounted price must be lower than the regular price'] } },
      );
      return;
    }

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
    try {
      await deleteAllFingerprintsForTenant(tenantId);
    } catch (err) {
      console.warn('[products.destroyAll] Failed to delete image fingerprints', { tenantId, err });
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
    try {
      await deleteFingerprintsForProduct(id, tenantId);
    } catch (err) {
      console.warn('[products.destroy] Failed to delete image fingerprints', { productId: id, err });
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
    await Promise.all(
      products.flatMap((p) =>
        (p.image_urls ?? []).map((imageUrl) =>
          defaultQueue.add(
            'product.imageFingerprint',
            { productId: p.id, tenantId, imageUrl },
            { priority: 2 },
          ),
        ),
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
    if (Array.isArray(product.image_urls) && product.image_urls.length > 0) {
      await queueProductImageFingerprintJobs(defaultQueue, product.id, tenantId, product.image_urls, 2);
    }
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(res, { product }, 'Product imported from image', 201);
  } catch (err) {
    sendError(res, 'Failed to process image', 500, err);
  }
}
