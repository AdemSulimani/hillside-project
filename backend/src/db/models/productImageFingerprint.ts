import crypto from 'crypto';
import pool from '../pool';
import { toSql } from 'pgvector';
import type { Product } from './product';

/**
 * Bump this whenever the vision extraction schema/prompt changes in a way that
 * should trigger an automatic re-extraction of existing catalog image fingerprints.
 * The reconciliation jobs re-fingerprint any row whose stored fingerprint_version
 * is below this value (see findMissingImageFingerprintCandidates).
 *
 * v1: original brand/name/type/flavor/size/visible_text fingerprint.
 * v2: adds servings/category/manufacturer named fields, a generic `attributes`
 *     map (any clearly-labeled packaging fact), and per-attribute confidence.
 */
export const CURRENT_FINGERPRINT_VERSION = 2;

export interface VisualFingerprintData {
  brand_name: string | null;
  product_name: string | null;
  product_type: string | null;
  flavor: string | null;
  size: string | null;
  /** Explicit serving count / serving information when legible (e.g. "60 servings"). */
  servings: string | null;
  /** Product category as printed/implied on the packaging (e.g. "protein powder"). */
  category: string | null;
  /** Manufacturer / distributor when distinct from the brand and clearly printed. */
  manufacturer: string | null;
  visible_text: string[];
  packaging_colors: string | null;
  distinguishing_features: string | null;
  sku_visible: string | null;
  barcode_visible: boolean;
  packaging_version_note: string | null;
  /**
   * Open-ended map of ANY other clearly-labeled packaging fact the model can read,
   * keyed by a normalized attribute name (e.g. { "protein per serving": "24g",
   * "weight": "2.27kg", "directions": "mix one scoop...", "warnings": "..." }).
   * This is what makes the system able to answer arbitrary attribute questions
   * rather than only a fixed list of fields.
   */
  attributes: Record<string, string>;
  /**
   * Per-attribute confidence in [0,1] for both the named fields above and the keys
   * in `attributes`. Used to gate whether an image-derived value is trustworthy
   * enough to answer a customer without escalation. Missing keys are treated as
   * low confidence by the resolution layer.
   */
  attribute_confidence: Record<string, number>;
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
  fingerprint_version: number;
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

/** Normalize an attribute key: lowercase, collapse whitespace, strip surrounding punctuation. */
export function normalizeAttributeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/[._]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s/+%-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Safely coerce a raw model-provided object into a bounded string→string attribute
 * map. Drops empty keys/values, caps key/value lengths and total entry count so a
 * misbehaving model response can never bloat the prompt or storage.
 */
export function normalizeAttributesMap(raw: unknown, maxEntries = 30): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= maxEntries) break;
    const key = normalizeAttributeKey(String(rawKey));
    if (!key || key.length > 60) continue;
    let value: string | null = null;
    if (typeof rawValue === 'string') value = rawValue.trim();
    else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') value = String(rawValue);
    if (!value) continue;
    out[key] = value.slice(0, 300);
  }
  return out;
}

/** Coerce a raw confidence map into normalized [0,1] numbers keyed by normalized attribute keys. */
export function normalizeConfidenceMap(raw: unknown, maxEntries = 60): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [rawKey, rawValue] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= maxEntries) break;
    const key = normalizeAttributeKey(String(rawKey));
    if (!key) continue;
    let n: number | null = null;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) n = rawValue;
    else if (typeof rawValue === 'string') {
      const parsed = parseFloat(rawValue.trim());
      if (Number.isFinite(parsed)) n = parsed;
    }
    if (n === null) continue;
    if (n > 1) n = n / 100;
    out[key] = Math.min(1, Math.max(0, n));
  }
  return out;
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
  fingerprintVersion?: number;
}): Promise<ProductImageFingerprint> {
  const imageUrlHash = hashImageUrl(input.imageUrl);
  const { rows } = await pool.query<ProductImageFingerprint>(
    `INSERT INTO product_image_fingerprints (
       tenant_id, product_id, image_url, image_url_hash,
       fingerprint_json, fingerprint_text,
       embedding, embedding_input_hash, embedding_model, fingerprint_version
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     ON CONFLICT (tenant_id, image_url_hash)
     DO UPDATE SET
       product_id           = EXCLUDED.product_id,
       image_url            = EXCLUDED.image_url,
       fingerprint_json     = EXCLUDED.fingerprint_json,
       fingerprint_text     = EXCLUDED.fingerprint_text,
       embedding            = COALESCE(EXCLUDED.embedding, product_image_fingerprints.embedding),
       embedding_input_hash = COALESCE(EXCLUDED.embedding_input_hash, product_image_fingerprints.embedding_input_hash),
       embedding_model      = COALESCE(EXCLUDED.embedding_model, product_image_fingerprints.embedding_model),
       fingerprint_version  = EXCLUDED.fingerprint_version,
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
      input.fingerprintVersion ?? CURRENT_FINGERPRINT_VERSION,
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

export async function deleteAllFingerprintsForTenant(tenantId: string): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM product_image_fingerprints WHERE tenant_id = $1`,
    [tenantId],
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

/**
 * Fetch all image fingerprints for a set of products in one query. Used at reply
 * time to surface verified packaging-derived attributes (brand, flavor, servings,
 * and any other readable label fact) when the structured catalog fields are empty.
 */
export async function findFingerprintsForProducts(
  tenantId: string,
  productIds: string[],
): Promise<ProductImageFingerprint[]> {
  const ids = [...new Set(productIds.filter((id) => typeof id === 'string' && id.length > 0))];
  if (ids.length === 0) return [];
  const { rows } = await pool.query<ProductImageFingerprint>(
    `SELECT * FROM product_image_fingerprints
     WHERE tenant_id = $1 AND product_id = ANY($2::uuid[])
     ORDER BY product_id, created_at ASC`,
    [tenantId, ids],
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
  minVersion: number = CURRENT_FINGERPRINT_VERSION,
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
       AND (pif.id IS NULL OR pif.embedding IS NULL OR COALESCE(pif.fingerprint_version, 1) < $2)
     ORDER BY p.updated_at DESC
     LIMIT $1`,
    [limit, minVersion],
  );
  return rows;
}

export async function findImageUrlsWithoutFingerprints(
  tenantId: string,
  limit = 500,
  minVersion: number = CURRENT_FINGERPRINT_VERSION,
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
       AND (pif.id IS NULL OR pif.embedding IS NULL OR COALESCE(pif.fingerprint_version, 1) < $3)
     ORDER BY p.updated_at DESC
     LIMIT $2`,
    [tenantId, limit, minVersion],
  );
  return rows;
}
