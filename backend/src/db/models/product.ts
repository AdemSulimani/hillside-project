import pool from '../pool';

export interface Product {
  id: string;
  tenant_id: string;
  name: string;
  price: number;
  description: string | null;
  sku: string | null;
  category: string | null;
  tags: string[];
  image_urls: string[];
  is_active: boolean;
  stock_quantity: number | null;
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
  price: number;
  description?: string | null;
  sku?: string | null;
  category?: string | null;
  tags?: string[];
  image_urls?: string[];
  is_active?: boolean;
  stock_quantity?: number | null;
  source_type?: Product['source_type'];
  extracted_text?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateProductInput {
  name?: string;
  price?: number;
  description?: string | null;
  sku?: string | null;
  category?: string | null;
  tags?: string[];
  image_urls?: string[];
  is_active?: boolean;
  stock_quantity?: number | null;
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
    `INSERT INTO products (tenant_id, name, price, description, sku, category, tags, image_urls, is_active, stock_quantity, source_type, extracted_text, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13::jsonb)
     RETURNING *`,
    [
      input.tenant_id,
      input.name,
      input.price,
      input.description ?? null,
      input.sku?.trim() || null,
      input.category?.trim() || null,
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.image_urls ?? []),
      input.is_active ?? true,
      input.stock_quantity ?? null,
      input.source_type ?? 'manual',
      input.extracted_text ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  );
  return rows[0];
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
      `(name ILIKE $${paramIdx} OR description ILIKE $${paramIdx} OR (sku IS NOT NULL AND sku ILIKE $${paramIdx}) OR (category IS NOT NULL AND category ILIKE $${paramIdx}))`,
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

export async function searchProducts(
  tenantId: string,
  query: string,
  limit = 10,
): Promise<Product[]> {
  const { rows } = await pool.query<Product>(
    `SELECT * FROM products
     WHERE tenant_id = $1 AND deleted_at IS NULL
       AND (name ILIKE $2 OR description ILIKE $2 OR (sku IS NOT NULL AND sku ILIKE $2) OR (category IS NOT NULL AND category ILIKE $2))
     ORDER BY name ASC
     LIMIT $3`,
    [tenantId, `%${query}%`, limit],
  );
  return rows;
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
