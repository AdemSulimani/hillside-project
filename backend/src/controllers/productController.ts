import type { Request, Response } from 'express';
import pool from '../db/pool';
import {
  createProduct,
  findProductsByTenant,
  findProductById,
  updateProduct,
  softDeleteProduct,
} from '../db/models/product';
import { sendSuccess, sendError, sendPaginated } from '../utils/response';
import { getDocumentService } from '../services/documents';
import { ImageProcessingService } from '../services/ImageProcessingService';
import { AIProductProcessingService } from '../services/AIProductProcessingService';
import { defaultQueue } from '../jobs/queues';
import type { CreateProductInput, UpdateProductInput } from '../validators/product';
import type { ProductQuery } from '../validators/product';
import { redisConnection } from '../jobs/redisConnection';

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
      price: input.price,
      description: input.description ?? null,
      sku: input.sku ?? null,
      category: input.category ?? null,
      tags: input.tags,
      is_active: input.is_active,
      stock_quantity: input.stock_quantity ?? null,
      source_type: 'manual',
    });

    await defaultQueue.add('product.embedding', {
      productId: product.id,
      tenantId,
    });
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

    const product = await updateProduct(id, tenantId, fields);
    if (!product) {
      sendError(res, 'Product not found', 404);
      return;
    }

    const embeddingRelevantFields = ['name', 'description', 'tags'] as const;
    const touchesEmbedding = embeddingRelevantFields.some(
      (f) => f in fields,
    );
    if (touchesEmbedding) {
      await defaultQueue.add('product.embedding', {
        productId: product.id,
        tenantId,
      });
    }
    await redisConnection.del(`products:${tenantId}`);

    sendSuccess(res, { product }, 'Product updated successfully');
  } catch (err) {
    sendError(res, 'Failed to update product', 500, err);
  }
}

export async function destroy(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);

    const deleted = await softDeleteProduct(id, tenantId);
    if (!deleted) {
      sendError(res, 'Product not found', 404);
      return;
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
    const service = getDocumentService(tenantId, req.file.mimetype);

    let products;
    if (useAI) {
      try {
        const aiService = new AIProductProcessingService();
        products = await service.processAndEnrich(
          req.file.path,
          aiService.createEnricher(),
        );
      } catch {
        products = await service.process(req.file.path);
      }
    } else {
      products = await service.process(req.file.path);
    }

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

    let product;
    if (useAI) {
      try {
        const aiService = new AIProductProcessingService();
        product = await imageService.processWithAI(
          req.file.path,
          aiService.createEnricher(),
        );
      } catch {
        product = await imageService.process(req.file.path);
      }
    } else {
      product = await imageService.process(req.file.path);
    }

    sendSuccess(res, { product }, 'Product imported from image', 201);
  } catch (err) {
    sendError(res, 'Failed to process image', 500, err);
  }
}
