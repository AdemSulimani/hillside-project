import crypto from 'crypto';
import pool from '../db/pool';
import { findProductById } from '../db/models/product';
import { generateEmbedding, buildProductText } from '../services/embeddingService';
import { OPENAI_EMBEDDING_MODEL } from '../services/openaiClient';
import { toSql } from 'pgvector';

export interface GenerateProductEmbeddingJobData {
  productId: string;
  tenantId: string;
}

/**
 * Compute a stable SHA-256 fingerprint of the text that was passed to buildProductText().
 * Stored alongside the embedding so we can detect stale embeddings without re-embedding
 * every row: if the current fingerprint of a product's fields differs from the stored
 * hash, the embedding is out of date and must be regenerated.
 */
export function hashEmbeddingInput(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
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
    {
      flavor: product.flavor ?? null,
      size: product.size ?? null,
      color: product.color ?? null,
      variant: product.variant ?? null,
      weight: product.weight ?? null,
    },
  );

  const inputHash = hashEmbeddingInput(text);
  const modelName = process.env.OPENAI_EMBEDDING_MODEL?.trim() || OPENAI_EMBEDDING_MODEL;

  const vector = await generateEmbedding(text);

  await pool.query(
    `UPDATE products
     SET embedding            = $1,
         embedding_input_hash = $2,
         embedding_model      = $3,
         updated_at           = now()
     WHERE id = $4 AND tenant_id = $5`,
    [toSql(vector), inputHash, modelName, productId, tenantId],
  );

  console.info('[embedding] Generated embedding for product', {
    productId,
    name: product.name,
    dimensions: vector.length,
    model: modelName,
  });
}
