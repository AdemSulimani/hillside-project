import pool from '../pool';
import { toSql } from 'pgvector';
import { extractBaseName } from '../../services/productTitleNormalization';

export interface Product {
  id: string;
  tenant_id: string;
  name: string;
  brand: string | null;
  price: number;
  discounted_price: number | null;
  description: string | null;
  usage_description: string | null;
  sku: string | null;
  category: string | null;
  tags: string[];
  flavor: string | null;
  size: string | null;
  color: string | null;
  variant: string | null;
  weight: string | null;
  image_urls: string[];
  is_active: boolean;
  in_stock: boolean;
  source_type: 'manual' | 'pdf' | 'spreadsheet' | 'image';
  extracted_text: string | null;
  metadata: Record<string, unknown> | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateProductInput {
  tenant_id: string;
  name: string;
  brand?: string | null;
  price: number;
  discounted_price?: number | null;
  description?: string | null;
  usage_description?: string | null;
  sku?: string | null;
  category?: string | null;
  tags?: string[];
  flavor?: string | null;
  size?: string | null;
  color?: string | null;
  variant?: string | null;
  weight?: string | null;
  image_urls?: string[];
  is_active?: boolean;
  in_stock?: boolean;
  source_type?: Product['source_type'];
  extracted_text?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateProductInput {
  name?: string;
  brand?: string | null;
  price?: number;
  discounted_price?: number | null;
  description?: string | null;
  usage_description?: string | null;
  sku?: string | null;
  category?: string | null;
  tags?: string[];
  flavor?: string | null;
  size?: string | null;
  color?: string | null;
  variant?: string | null;
  weight?: string | null;
  image_urls?: string[];
  is_active?: boolean;
  in_stock?: boolean;
  extracted_text?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ProductSearchParams {
  tenantId: string;
  search?: string;
  tags?: string[];
  isActive?: boolean;
  page?: number;
  limit?: number;
}

export async function createProduct(input: CreateProductInput): Promise<Product> {
  const { rows } = await pool.query<Product>(
    `INSERT INTO products (tenant_id, name, brand, price, discounted_price, description, usage_description, sku, category, tags, flavor, size, color, variant, weight, image_urls, is_active, in_stock, source_type, extracted_text, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21::jsonb)
     RETURNING *`,
    [
      input.tenant_id,
      input.name,
      input.brand?.trim() || null,
      input.price,
      input.discounted_price ?? null,
      input.description ?? null,
      input.usage_description ?? null,
      input.sku?.trim() || null,
      input.category?.trim() || null,
      JSON.stringify(input.tags ?? []),
      input.flavor?.trim() || null,
      input.size?.trim() || null,
      input.color?.trim() || null,
      input.variant?.trim() || null,
      input.weight?.trim() || null,
      JSON.stringify(input.image_urls ?? []),
      input.is_active ?? true,
      input.in_stock ?? true,
      input.source_type ?? 'manual',
      input.extracted_text ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return rows[0];
}

/**
 * Insert a product or, if a non-deleted product with the same (tenant_id, name)
 * already exists, update its fields in place and return the surviving row.
 *
 * This prevents duplicate catalog rows when a tenant re-uploads a spreadsheet
 * or PDF. The uniqueness check is case/whitespace-insensitive, matching the
 * partial unique index idx_products_tenant_name_unique (migration 046).
 *
 * Returns `{ product, wasUpdated }` so callers can decide whether to re-queue
 * an embedding job (always safe to re-queue; the embedding worker is idempotent).
 */
export async function upsertProductByName(
  input: CreateProductInput,
): Promise<{ product: Product; wasUpdated: boolean }> {
  const { rows } = await pool.query<Product & { xmax: string }>(
    `INSERT INTO products (
       tenant_id, name, brand, price, discounted_price, description,
       usage_description, sku, category, tags, flavor, size, color, variant, weight,
       image_urls, is_active, in_stock, source_type, extracted_text, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16::jsonb, $17, $18, $19, $20, $21::jsonb)
     ON CONFLICT (tenant_id, LOWER(TRIM(name))) WHERE deleted_at IS NULL
     DO UPDATE SET
       brand              = EXCLUDED.brand,
       price              = EXCLUDED.price,
       discounted_price   = EXCLUDED.discounted_price,
       description        = EXCLUDED.description,
       usage_description  = EXCLUDED.usage_description,
       sku                = EXCLUDED.sku,
       category           = EXCLUDED.category,
       tags               = EXCLUDED.tags,
       flavor             = EXCLUDED.flavor,
       size               = EXCLUDED.size,
       color              = EXCLUDED.color,
       variant            = EXCLUDED.variant,
       weight             = EXCLUDED.weight,
       image_urls         = CASE
                              WHEN jsonb_array_length(COALESCE(EXCLUDED.image_urls, '[]'::jsonb)) > 0
                              THEN EXCLUDED.image_urls
                              ELSE products.image_urls
                            END,
       is_active          = EXCLUDED.is_active,
       in_stock           = EXCLUDED.in_stock,
       source_type        = EXCLUDED.source_type,
       extracted_text     = EXCLUDED.extracted_text,
       metadata           = EXCLUDED.metadata,
       updated_at         = now()
     RETURNING *, xmax::text`,
    [
      input.tenant_id,
      input.name,
      input.brand?.trim() || null,
      input.price,
      input.discounted_price ?? null,
      input.description ?? null,
      input.usage_description ?? null,
      input.sku?.trim() || null,
      input.category?.trim() || null,
      JSON.stringify(input.tags ?? []),
      input.flavor?.trim() || null,
      input.size?.trim() || null,
      input.color?.trim() || null,
      input.variant?.trim() || null,
      input.weight?.trim() || null,
      JSON.stringify(input.image_urls ?? []),
      input.is_active ?? true,
      input.in_stock ?? true,
      input.source_type ?? 'manual',
      input.extracted_text ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  const row = rows[0];
  // xmax = '0' means the row was freshly inserted; non-zero means it was updated.
  const wasUpdated = row.xmax !== '0';
  const product: Product = { ...row };
  return { product, wasUpdated };
}

export async function findProductsByTenant(
  params: ProductSearchParams,
): Promise<{ products: Product[]; total: number }> {
  const page = params.page ?? 1;
  const limit = params.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['tenant_id = $1', 'deleted_at IS NULL'];
  const values: unknown[] = [params.tenantId];
  let paramIdx = 2;

  if (params.search) {
    conditions.push(
      `(name ILIKE $${paramIdx} OR (brand IS NOT NULL AND brand ILIKE $${paramIdx}) OR description ILIKE $${paramIdx} OR (sku IS NOT NULL AND sku ILIKE $${paramIdx}) OR (category IS NOT NULL AND category ILIKE $${paramIdx}) OR (flavor IS NOT NULL AND flavor ILIKE $${paramIdx}) OR (size IS NOT NULL AND size ILIKE $${paramIdx}) OR (color IS NOT NULL AND color ILIKE $${paramIdx}) OR (variant IS NOT NULL AND variant ILIKE $${paramIdx}) OR (weight IS NOT NULL AND weight ILIKE $${paramIdx}))`,
    );
    values.push(`%${params.search}%`);
    paramIdx++;
  }

  if (params.tags && params.tags.length > 0) {
    conditions.push(`tags @> $${paramIdx}::jsonb`);
    values.push(JSON.stringify(params.tags));
    paramIdx++;
  }

  if (params.isActive !== undefined) {
    conditions.push(`is_active = $${paramIdx}`);
    values.push(params.isActive);
    paramIdx++;
  }

  const where = conditions.join(' AND ');

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM products WHERE ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const { rows } = await pool.query<Product>(
    `SELECT * FROM products WHERE ${where} ORDER BY created_at DESC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset],
  );

  return { products: rows, total };
}

/** Returns another active product id with the same normalized name, if any. */
export async function findConflictingProductIdByName(
  tenantId: string,
  name: string,
  excludeId?: string,
): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM products
     WHERE tenant_id = $1
       AND deleted_at IS NULL
       AND LOWER(TRIM(name)) = LOWER(TRIM($2))
       AND ($3::uuid IS NULL OR id <> $3)
     LIMIT 1`,
    [tenantId, trimmed, excludeId ?? null],
  );
  return rows[0]?.id ?? null;
}

export async function findProductById(
  id: string,
  tenantId: string,
): Promise<Product | null> {
  const { rows } = await pool.query<Product>(
    'SELECT * FROM products WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
    [id, tenantId],
  );
  return rows[0] ?? null;
}

export async function updateProduct(
  id: string,
  tenantId: string,
  fields: UpdateProductInput,
): Promise<Product | null> {
  const keys = Object.keys(fields) as (keyof UpdateProductInput)[];
  if (keys.length === 0) return findProductById(id, tenantId);

  const jsonbFields = new Set(['tags', 'image_urls', 'metadata']);
  const setClauses: string[] = [];
  const values: unknown[] = [id, tenantId];
  let paramIdx = 3;

  for (const key of keys) {
    if (jsonbFields.has(key)) {
      setClauses.push(`${key} = $${paramIdx}::jsonb`);
      values.push(JSON.stringify(fields[key]));
    } else {
      setClauses.push(`${key} = $${paramIdx}`);
      values.push(fields[key]);
    }
    paramIdx++;
  }
  setClauses.push('updated_at = now()');

  const { rows } = await pool.query<Product>(
    `UPDATE products SET ${setClauses.join(', ')} WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL RETURNING *`,
    values,
  );
  return rows[0] ?? null;
}

export async function softDeleteProduct(
  id: string,
  tenantId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'UPDATE products SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL',
    [id, tenantId],
  );
  return (rowCount ?? 0) > 0;
}

export async function softDeleteAllProducts(
  tenantId: string,
): Promise<{ deletedCount: number; imageUrls: string[] }> {
  const { rows, rowCount } = await pool.query<{ image_urls: string[] }>(
    `UPDATE products SET deleted_at = now(), updated_at = now()
     WHERE tenant_id = $1 AND deleted_at IS NULL
     RETURNING image_urls`,
    [tenantId],
  );
  const imageUrls = rows.flatMap((row) => row.image_urls ?? []);
  return { deletedCount: rowCount ?? 0, imageUrls };
}

/** Case-insensitive match: exact name first, then first ILIKE substring match (shortest name wins). */
export async function findProductByNameCaseInsensitive(
  tenantId: string,
  name: string,
): Promise<Product | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const exact = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND LOWER(TRIM(name)) = LOWER($2)
     LIMIT 1`,
    [tenantId, trimmed],
  );
  if (exact.rows[0]) return exact.rows[0];

  const { rows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND name ILIKE $2
     ORDER BY LENGTH(name) ASC, name ASC
     LIMIT 1`,
    [tenantId, `%${trimmed}%`],
  );
  if (rows[0]) return rows[0];

  // Reverse match: the intent string is a superset of the DB product name
  // (e.g. intent = "Nitro Tech Ripped nga Muscletech", DB = "Nitro Tech Ripped").
  // Pick the longest DB name that is fully contained within the intent string so
  // we prefer the most specific product when multiple names would match.
  const { rows: reverseRows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND $2 ILIKE CONCAT('%', TRIM(name), '%')
     ORDER BY LENGTH(name) DESC, name ASC
     LIMIT 1`,
    [tenantId, trimmed],
  );
  return reverseRows[0] ?? null;
}

/**
 * Returns every active product whose name contains the given substring (case-insensitive).
 *
 * Unlike {@link findProductByNameCaseInsensitive}, this does NOT collapse to a single row.
 * It is used by order-product resolution to gather the full set of variant candidates
 * (e.g. both "Creatine 50 Servings" and "Creatine 60 Servings") so the customer's
 * selected variant can be disambiguated explicitly instead of silently tie-broken.
 */
export async function findActiveProductsByNameSubstring(
  tenantId: string,
  substring: string,
  limit = 25,
): Promise<Product[]> {
  const trimmed = substring.trim();
  if (!trimmed) return [];
  const { rows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND name ILIKE $2
     ORDER BY LENGTH(name) ASC, name ASC
     LIMIT $3`,
    [tenantId, `%${trimmed}%`, limit],
  );
  return rows;
}

/**
 * Deterministic SKU lookup used by the image-vision pipeline. When a barcode or
 * SKU is legibly read from a customer photo it is the single strongest matching
 * signal we can get — far more reliable than fuzzy visual/caption similarity — so
 * a hit here is treated as a confident match and short-circuits the scoring ladder.
 *
 * Matching is case/whitespace-insensitive and tolerates a leading-zero / non-digit
 * formatting mismatch on otherwise-equal numeric codes (barcodes are frequently
 * stored with different padding than they are printed).
 */
export async function findActiveProductBySku(
  tenantId: string,
  sku: string,
): Promise<Product | null> {
  const trimmed = sku.trim();
  if (trimmed.length < 3) return null;

  const exact = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND sku IS NOT NULL
       AND LOWER(TRIM(sku)) = LOWER($2)
     LIMIT 1`,
    [tenantId, trimmed],
  );
  if (exact.rows[0]) return exact.rows[0];

  // Fall back to a digits-only comparison for numeric codes (barcodes/EANs) so a
  // formatting/padding difference does not defeat an otherwise exact match.
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length >= 6) {
    const { rows } = await pool.query<Product>(
      `SELECT * FROM products
       WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
         AND sku IS NOT NULL
         AND regexp_replace(sku, '\\D', '', 'g') = $2
       ORDER BY LENGTH(sku) ASC
       LIMIT 1`,
      [tenantId, digits],
    );
    if (rows[0]) return rows[0];
  }

  return null;
}

export async function searchProducts(
  tenantId: string,
  query: string,
  limit = 10,
): Promise<Product[]> {
  const { rows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND is_active = true
       AND (
         name ILIKE $2
         OR (brand IS NOT NULL AND brand ILIKE $2)
         OR description ILIKE $2
         OR (category IS NOT NULL AND category ILIKE $2)
         OR tags::text ILIKE $2
         OR (flavor IS NOT NULL AND flavor ILIKE $2)
         OR (size IS NOT NULL AND size ILIKE $2)
         OR (color IS NOT NULL AND color ILIKE $2)
         OR (variant IS NOT NULL AND variant ILIKE $2)
         OR (weight IS NOT NULL AND weight ILIKE $2)
       )
     ORDER BY name ASC
     LIMIT $3`,
    [tenantId, `%${query}%`, limit],
  );
  return rows;
}

/**
 * Token-aware product search: every supplied token must appear in at least one
 * searchable field (logical AND across tokens, OR across fields per token).
 *
 * This is the retrieval primitive for the image-matching pipeline. Unlike
 * {@link searchProducts} — which requires the ENTIRE query string to appear
 * contiguously in a single field — this matches a base-name token set like
 * `["creatine", "monohydrate"]` against "Creatine Monohydrate 50 Servings",
 * "Creatine Monohydrate 100 Servings", etc. Extra variant attributes in the title
 * (servings/flavor/size) no longer break retrieval, because they are simply absent
 * from the required token set rather than being demanded as a contiguous substring.
 *
 * Callers pass BASE-NAME tokens (identity) here and use attribute-aware re-ranking
 * afterwards to surface the specific variant the photo shows.
 */
export async function searchProductsByTokens(
  tenantId: string,
  tokens: string[],
  limit = 10,
): Promise<Product[]> {
  const cleaned = [
    ...new Set(tokens.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 2)),
  ].slice(0, 8);
  if (cleaned.length === 0) return [];

  const conditions: string[] = [];
  const values: unknown[] = [tenantId];
  let idx = 2;
  for (const token of cleaned) {
    conditions.push(`(
      name ILIKE $${idx}
      OR (brand IS NOT NULL AND brand ILIKE $${idx})
      OR (category IS NOT NULL AND category ILIKE $${idx})
      OR (flavor IS NOT NULL AND flavor ILIKE $${idx})
      OR (size IS NOT NULL AND size ILIKE $${idx})
      OR (variant IS NOT NULL AND variant ILIKE $${idx})
      OR (weight IS NOT NULL AND weight ILIKE $${idx})
      OR tags::text ILIKE $${idx}
    )`);
    values.push(`%${token}%`);
    idx++;
  }

  const { rows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND ${conditions.join(' AND ')}
     ORDER BY LENGTH(name) ASC, name ASC
     LIMIT $${idx}`,
    [...values, limit],
  );
  return rows;
}

/**
 * Strip size/flavor tokens to find variant siblings in the same product family.
 *
 * Delegates to the shared {@link extractBaseName} normaliser so the family base name,
 * the order-resolution disambiguation, and the image-matching token search all parse
 * titles identically (single source of truth). Capped at 6 words to keep the sibling
 * ILIKE pattern broad enough to gather the whole variant family.
 */
export function extractProductFamilyBaseName(name: string): string {
  return extractBaseName(name, 6);
}

/**
 * Find other active SKUs likely belonging to the same product family (variants).
 */
export async function findVariantSiblingProducts(
  tenantId: string,
  product: Product,
  limit = 24,
): Promise<Product[]> {
  const baseName = extractProductFamilyBaseName(product.name);
  const pattern = `%${baseName.slice(0, 48)}%`;

  const brand = product.brand?.trim() || null;
  const category = product.category?.trim() || null;

  const { rows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND id <> $2
       AND (
         name ILIKE $3
         OR (
           $4::text IS NOT NULL
           AND brand = $4
           AND ($5::text IS NULL OR category = $5)
         )
       )
     ORDER BY name ASC
     LIMIT $6`,
    [tenantId, product.id, pattern, brand, category, limit],
  );

  return rows;
}

/**
 * Match products whose category or tags contain the phrase (e.g. "shtim peshe").
 */
export async function searchProductsByCategoryOrTag(
  tenantId: string,
  phrase: string,
  limit = 10,
): Promise<Product[]> {
  const trimmed = phrase.trim();
  if (trimmed.length < 2) return [];

  const { rows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
       AND (
         name ILIKE $2
         OR (category IS NOT NULL AND category ILIKE $2)
         OR tags::text ILIKE $2
       )
     ORDER BY name ASC
     LIMIT $3`,
    [tenantId, `%${trimmed}%`, limit],
  );
  return rows;
}

/**
 * Search category/tags for each phrase; de-duplicates by product id.
 */
export async function searchProductsByCatalogPhrases(
  tenantId: string,
  phrases: string[],
  limit = 10,
): Promise<Product[]> {
  const seen = new Set<string>();
  const out: Product[] = [];

  for (const phrase of phrases) {
    if (phrase.trim().length < 4) continue;
    const rows = await searchProductsByCategoryOrTag(tenantId, phrase, limit);
    for (const p of rows) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
        if (out.length >= limit) return out;
      }
    }
  }

  return out;
}

/**
 * Match products if any term hits name, brand, description, or tags (each term uses ILIKE).
 * De-duplicates by product id. Use when a full-sentence search string would not appear
 * contiguously in catalog fields (e.g. "A keni mass gainer?" vs "Mass Gainer Pro").
 */
export async function searchProductsByDisjunctiveTerms(
  tenantId: string,
  terms: string[],
  limit = 10,
): Promise<Product[]> {
  const cleaned = [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 10);
  if (cleaned.length === 0) return [];
  const seen = new Set<string>();
  const out: Product[] = [];
  for (const term of cleaned) {
    const rows = await searchProducts(tenantId, term, limit);
    for (const p of rows) {
      if (!seen.has(p.id)) {
        seen.add(p.id);
        out.push(p);
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

export interface SimilarProduct extends Product {
  similarity: number;
}

/**
 * Candidate pool size for the HNSW graph traversal. The `embedding` index is GLOBAL
 * (not partitioned per tenant), and the tenant filter is applied AFTER the ANN scan.
 * With the pgvector default (40) a tenant whose products are a small fraction of all
 * rows can have its correct matches fall outside the global top-40 and silently return
 * fewer than `limit` rows — the "the right product exists but wasn't retrieved" bug.
 * A larger ef_search widens the candidate pool so post-filtering still yields `limit`
 * rows, at the cost of some latency. Must be >= the requested limit.
 */
const HNSW_EF_SEARCH = (() => {
  const raw = process.env.HNSW_EF_SEARCH;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

/**
 * Vector similarity search using pgvector's cosine distance operator.
 * Returns products ordered by closest embedding match.
 *
 * Runs inside a transaction so `SET LOCAL hnsw.ef_search` only affects this query and
 * is reset automatically when the (pooled) connection is returned — it never leaks to
 * other queries sharing the same pool client.
 */
export async function searchProductsBySimilarity(
  tenantId: string,
  queryEmbedding: number[],
  limit = 5,
): Promise<SimilarProduct[]> {
  const efSearch = Math.max(HNSW_EF_SEARCH, limit);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    const { rows } = await client.query<SimilarProduct>(
      `SELECT *, 1 - (embedding <=> $2) AS similarity
       FROM products
       WHERE tenant_id = $1
         AND deleted_at IS NULL
         AND is_active = true
         AND embedding IS NOT NULL
       ORDER BY embedding <=> $2
       LIMIT $3`,
      [tenantId, toSql(queryEmbedding), limit],
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Returns the number of active, non-deleted products for a tenant. */
export async function countActiveProducts(tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true`,
    [tenantId],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Returns the number of active products that have no embedding yet.
 * Used for diagnostics and to decide when to auto-backfill embeddings.
 */
export async function countProductsWithoutEmbeddings(tenantId: string): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true AND embedding IS NULL`,
    [tenantId],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

/**
 * Returns IDs and names of active products that have no embedding yet.
 * Capped at 500 rows so it is safe to call in a job context.
 */
export async function findProductsWithoutEmbeddings(
  tenantId: string,
  limit = 500,
): Promise<Array<{ id: string; name: string }>> {
  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true AND embedding IS NULL
     ORDER BY created_at ASC
     LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/**
 * Returns the names of all active products for a tenant.
 * Used to provide the intent detection LLM with an exact catalog list so it can
 * normalise the customer's phrasing to a real product name.
 * Capped at 200 rows — tenants with larger catalogs should rely on the fuzzy
 * matching fallback in findProductByNameCaseInsensitive.
 */
export async function findActiveProductNamesForTenant(tenantId: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    `SELECT name FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL AND is_active = true
     ORDER BY name ASC
     LIMIT 200`,
    [tenantId],
  );
  return rows.map((r) => r.name);
}

export async function appendImageUrls(
  id: string,
  tenantId: string,
  urls: string[],
): Promise<Product | null> {
  const { rows } = await pool.query<Product>(
    `UPDATE products
     SET image_urls = image_urls || $3::jsonb, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
     RETURNING *`,
    [id, tenantId, JSON.stringify(urls)],
  );
  return rows[0] ?? null;
}
