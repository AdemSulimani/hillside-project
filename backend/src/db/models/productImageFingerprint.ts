import crypto from 'crypto';
import pool from '../pool';
import { toSql } from 'pgvector';
import type { Product } from './product';

export interface VisualFingerprintData {
  brand_name: string | null;
  product_name: string | null;
  product_type: string | null;
  flavor: string | null;
  size: string | null;
  visible_text: string[];
  packaging_colors: string | null;
  distinguishing_features: string | null;
  sku_visible: string | null;
  barcode_visible: boolean;
  packaging_version_note: string | null;
}

export interface ProductImageFingerprint {
  id: string;
  tenant_id: string;
  product_id: string;
  image_url: string;
  image_url_hash: string;
  fingerprint_json: VisualFingerprintData;
  fingerprint_text: string;
  embedding: number[] | null;
  embedding_input_hash: string | null;
  embedding_model: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ImageFingerprintMatch extends Product {
  similarity: number;
  fingerprint_id: string;
  matched_image_url: string;
}

export function hashImageUrl(url: string): string {
  return crypto.createHash('sha256').update(url.trim(), 'utf8').digest('hex');
}

const HNSW_EF_SEARCH = (() => {
  const raw = process.env.HNSW_EF_SEARCH;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

export async function upsertProductImageFingerprint(input: {
  tenantId: string;
  productId: string;
  imageUrl: string;
  fingerprintJson: VisualFingerprintData;
  fingerprintText: string;
  embedding?: number[] | null;
  embeddingInputHash?: string | null;
  embeddingModel?: string | null;
}): Promise<ProductImageFingerprint> {
  const imageUrlHash = hashImageUrl(input.imageUrl);
  const { rows } = await pool.query<ProductImageFingerprint>(
    `INSERT INTO product_image_fingerprints (
       tenant_id, product_id, image_url, image_url_hash,
       fingerprint_json, fingerprint_text,
       embedding, embedding_input_hash, embedding_model
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
     ON CONFLICT (tenant_id, image_url_hash)
     DO UPDATE SET
       product_id           = EXCLUDED.product_id,
       image_url            = EXCLUDED.image_url,
       fingerprint_json     = EXCLUDED.fingerprint_json,
       fingerprint_text     = EXCLUDED.fingerprint_text,
       embedding            = COALESCE(EXCLUDED.embedding, product_image_fingerprints.embedding),
       embedding_input_hash = COALESCE(EXCLUDED.embedding_input_hash, product_image_fingerprints.embedding_input_hash),
       embedding_model      = COALESCE(EXCLUDED.embedding_model, product_image_fingerprints.embedding_model),
       updated_at           = now()
     RETURNING *`,
    [
      input.tenantId,
      input.productId,
      input.imageUrl,
      imageUrlHash,
      JSON.stringify(input.fingerprintJson),
      input.fingerprintText,
      input.embedding ? toSql(input.embedding) : null,
      input.embeddingInputHash ?? null,
      input.embeddingModel ?? null,
    ],
  );
  return rows[0];
}

export async function updateProductImageFingerprintEmbedding(
  id: string,
  tenantId: string,
  embedding: number[],
  embeddingInputHash: string,
  embeddingModel: string,
): Promise<void> {
  await pool.query(
    `UPDATE product_image_fingerprints
     SET embedding = $1,
         embedding_input_hash = $2,
         embedding_model = $3,
         updated_at = now()
     WHERE id = $4 AND tenant_id = $5`,
    [toSql(embedding), embeddingInputHash, embeddingModel, id, tenantId],
  );
}

export async function deleteFingerprintsForImageUrls(
  tenantId: string,
  imageUrls: string[],
): Promise<number> {
  if (imageUrls.length === 0) return 0;
  const hashes = imageUrls.map(hashImageUrl);
  const { rowCount } = await pool.query(
    `DELETE FROM product_image_fingerprints
     WHERE tenant_id = $1 AND image_url_hash = ANY($2::text[])`,
    [tenantId, hashes],
  );
  return rowCount ?? 0;
}

export async function deleteFingerprintsForProduct(
  productId: string,
  tenantId: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM product_image_fingerprints
     WHERE product_id = $1 AND tenant_id = $2`,
    [productId, tenantId],
  );
  return rowCount ?? 0;
}

export async function findProductImageFingerprintsByProduct(
  productId: string,
  tenantId: string,
): Promise<ProductImageFingerprint[]> {
  const { rows } = await pool.query<ProductImageFingerprint>(
    `SELECT * FROM product_image_fingerprints
     WHERE product_id = $1 AND tenant_id = $2
     ORDER BY created_at ASC`,
    [productId, tenantId],
  );
  return rows;
}

export async function searchProductsByImageFingerprintSimilarity(
  tenantId: string,
  queryEmbedding: number[],
  limit = 10,
  minSimilarity = 0.6,
): Promise<ImageFingerprintMatch[]> {
  const efSearch = Math.max(HNSW_EF_SEARCH, limit * 3);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    const { rows } = await client.query<ImageFingerprintMatch>(
      `SELECT
         p.*,
         1 - (pif.embedding <=> $2) AS similarity,
         pif.id AS fingerprint_id,
         pif.image_url AS matched_image_url
       FROM product_image_fingerprints pif
       INNER JOIN products p ON p.id = pif.product_id
       WHERE pif.tenant_id = $1
         AND pif.embedding IS NOT NULL
         AND p.deleted_at IS NULL
         AND p.is_active = true
         AND 1 - (pif.embedding <=> $2) >= $4
       ORDER BY pif.embedding <=> $2
       LIMIT $3`,
      [tenantId, toSql(queryEmbedding), limit, minSimilarity],
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function countMissingImageFingerprints(tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM products p
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p.image_urls, '[]'::jsonb)) AS img(url)
     LEFT JOIN product_image_fingerprints pif
       ON pif.tenant_id = p.tenant_id
      AND pif.image_url_hash = encode(digest(img.url, 'sha256'), 'hex')
     WHERE p.tenant_id = $1
       AND p.deleted_at IS NULL
       AND p.is_active = true
       AND pif.id IS NULL`,
    [tenantId],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export interface MissingFingerprintCandidate {
  product_id: string;
  tenant_id: string;
  image_url: string;
}

export async function findMissingImageFingerprintCandidates(
  limit = 200,
): Promise<MissingFingerprintCandidate[]> {
  const { rows } = await pool.query<MissingFingerprintCandidate>(
    `SELECT p.id AS product_id, p.tenant_id, img.url AS image_url
     FROM products p
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p.image_urls, '[]'::jsonb)) AS img(url)
     LEFT JOIN product_image_fingerprints pif
       ON pif.tenant_id = p.tenant_id
      AND pif.image_url_hash = encode(digest(img.url, 'sha256'), 'hex')
     WHERE p.deleted_at IS NULL
       AND p.is_active = true
       AND img.url IS NOT NULL
       AND TRIM(img.url) <> ''
       AND (pif.id IS NULL OR pif.embedding IS NULL)
     ORDER BY p.updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function findImageUrlsWithoutFingerprints(
  tenantId: string,
  limit = 500,
): Promise<MissingFingerprintCandidate[]> {
  const { rows } = await pool.query<MissingFingerprintCandidate>(
    `SELECT p.id AS product_id, p.tenant_id, img.url AS image_url
     FROM products p
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p.image_urls, '[]'::jsonb)) AS img(url)
     LEFT JOIN product_image_fingerprints pif
       ON pif.tenant_id = p.tenant_id
      AND pif.image_url_hash = encode(digest(img.url, 'sha256'), 'hex')
     WHERE p.tenant_id = $1
       AND p.deleted_at IS NULL
       AND p.is_active = true
       AND img.url IS NOT NULL
       AND TRIM(img.url) <> ''
       AND (pif.id IS NULL OR pif.embedding IS NULL)
     ORDER BY p.updated_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}
