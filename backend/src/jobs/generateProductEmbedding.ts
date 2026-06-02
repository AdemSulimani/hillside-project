import pool from '../db/pool';
import { findProductById } from '../db/models/product';
import { generateEmbedding, buildProductText } from '../services/embeddingService';
import { toSql } from 'pgvector';

export interface GenerateProductEmbeddingJobData {
  productId: string;
  tenantId: string;
}

export async function processGenerateProductEmbedding(
  data: GenerateProductEmbeddingJobData,
): Promise<void> {
  const { productId, tenantId } = data;

  const product = await findProductById(productId, tenantId);
  if (!product) {
    console.warn('[embedding] Product not found, skipping', { productId, tenantId });
    return;
  }

  const tags: string[] = Array.isArray(product.tags) ? product.tags : [];
  const text = buildProductText(
    product.name,
    product.description,
    tags,
    product.brand ?? null,
    product.category ?? null,
    product.usage_description ?? null,
  );

  const vector = await generateEmbedding(text);

  await pool.query(
    `UPDATE products SET embedding = $1, updated_at = now()
     WHERE id = $2 AND tenant_id = $3`,
    [toSql(vector), productId, tenantId],
  );

  console.info('[embedding] Generated embedding for product', {
    productId,
    name: product.name,
    dimensions: vector.length,
  });
}
