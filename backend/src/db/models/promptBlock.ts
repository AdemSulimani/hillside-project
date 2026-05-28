import pool from '../pool';
import type { PoolClient } from 'pg';

export interface PromptBlockCatalog {
  id: string;
  key: string;
  title: string;
  description: string | null;
  default_content: string;
  category: string;
  sort_order: number;
  is_platform_locked: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface TenantPromptBlockRow {
  id: string;
  tenant_id: string;
  prompt_block_id: string | null;
  block_key: string;
  enabled: boolean;
  content: string;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export type TenantPromptBlockWithMeta = TenantPromptBlockRow & {
  is_platform_locked: boolean | null;
  catalog_title: string | null;
};

export async function listAllCatalogPromptBlocks(includeInactive = false): Promise<PromptBlockCatalog[]> {
  const { rows } = await pool.query<PromptBlockCatalog>(
    includeInactive
      ? `SELECT * FROM prompt_blocks ORDER BY sort_order ASC, key ASC`
      : `SELECT * FROM prompt_blocks WHERE is_active = true ORDER BY sort_order ASC, key ASC`,
  );
  return rows;
}

export type InsertCatalogPromptBlockInput = {
  key: string;
  title: string;
  description?: string | null;
  default_content: string;
  category: string;
  sort_order: number;
  is_platform_locked: boolean;
  is_active: boolean;
};

export async function insertCatalogPromptBlock(
  input: InsertCatalogPromptBlockInput,
): Promise<PromptBlockCatalog> {
  const { rows } = await pool.query<PromptBlockCatalog>(
    `INSERT INTO prompt_blocks (key, title, description, default_content, category, sort_order, is_platform_locked, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.key,
      input.title,
      input.description ?? null,
      input.default_content,
      input.category,
      input.sort_order,
      input.is_platform_locked,
      input.is_active,
    ],
  );
  return rows[0];
}

export type UpdateCatalogPromptBlockInput = Partial<{
  title: string;
  description: string | null;
  default_content: string;
  category: string;
  sort_order: number;
  is_platform_locked: boolean;
  is_active: boolean;
}>;

export async function updateCatalogPromptBlock(
  id: string,
  input: UpdateCatalogPromptBlockInput,
): Promise<PromptBlockCatalog | null> {
  const keys = Object.keys(input) as (keyof UpdateCatalogPromptBlockInput)[];
  if (keys.length === 0) return null;

  const setClauses = keys.map((k, i) => `${k} = $${i + 2}`);
  setClauses.push('updated_at = now()');
  const values = keys.map((k) => input[k]);

  const { rows } = await pool.query<PromptBlockCatalog>(
    `UPDATE prompt_blocks SET ${setClauses.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] ?? null;
}

export async function countTenantPromptBlocks(
  tenantId: string,
  client?: PoolClient,
): Promise<number> {
  const ex = client ?? pool;
  const { rows } = await ex.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tenant_prompt_blocks WHERE tenant_id = $1`,
    [tenantId],
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}

/** Idempotent: copies every active catalog block for a tenant when missing rows. */
export async function seedTenantPromptBlocksFromCatalog(
  tenantId: string,
  client?: PoolClient,
): Promise<void> {
  const ex = client ?? pool;
  await ex.query(
    `INSERT INTO tenant_prompt_blocks (tenant_id, prompt_block_id, block_key, enabled, content, sort_order)
     SELECT $1::uuid, pb.id, pb.key, true, pb.default_content, pb.sort_order
     FROM prompt_blocks pb
     WHERE pb.is_active = true
     ON CONFLICT (tenant_id, block_key) DO NOTHING`,
    [tenantId],
  );
}

export async function listTenantPromptBlocksRuntime(tenantId: string): Promise<TenantPromptBlockRow[]> {
  const { rows } = await pool.query<TenantPromptBlockRow>(
    `SELECT id, tenant_id, prompt_block_id, block_key, enabled, content, sort_order, created_at, updated_at
     FROM tenant_prompt_blocks
     WHERE tenant_id = $1
     ORDER BY sort_order ASC, block_key ASC`,
    [tenantId],
  );
  return rows;
}

export async function listTenantPromptBlocksWithMeta(
  tenantId: string,
): Promise<TenantPromptBlockWithMeta[]> {
  const { rows } = await pool.query<TenantPromptBlockWithMeta>(
    `SELECT tpb.*,
            pb.is_platform_locked,
            pb.title AS catalog_title
     FROM tenant_prompt_blocks tpb
     LEFT JOIN prompt_blocks pb ON pb.id = tpb.prompt_block_id
     WHERE tpb.tenant_id = $1
     ORDER BY tpb.sort_order ASC, tpb.block_key ASC`,
    [tenantId],
  );
  return rows;
}

export async function findTenantPromptBlockForAdmin(
  tenantId: string,
  id: string,
): Promise<TenantPromptBlockWithMeta | null> {
  const { rows } = await pool.query<TenantPromptBlockWithMeta>(
    `SELECT tpb.*,
            pb.is_platform_locked,
            pb.title AS catalog_title
     FROM tenant_prompt_blocks tpb
     LEFT JOIN prompt_blocks pb ON pb.id = tpb.prompt_block_id
     WHERE tpb.tenant_id = $1 AND tpb.id = $2
     LIMIT 1`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

export async function updateTenantPromptBlock(
  tenantId: string,
  id: string,
  fields: { enabled?: boolean; content?: string; sort_order?: number },
): Promise<TenantPromptBlockWithMeta | null> {
  const keys = Object.keys(fields) as (keyof typeof fields)[];
  if (keys.length === 0) return findTenantPromptBlockForAdmin(tenantId, id);

  const setClauses: string[] = [];
  const values: unknown[] = [tenantId, id];

  keys.forEach((key, i) => {
    const paramIdx = i + 3;
    setClauses.push(`${key} = $${paramIdx}`);
    values.push(fields[key]);
  });
  setClauses.push('updated_at = now()');

  const { rows } = await pool.query<TenantPromptBlockWithMeta>(
    `UPDATE tenant_prompt_blocks tpb
     SET ${setClauses.join(', ')}
     WHERE tpb.tenant_id = $1 AND tpb.id = $2
     RETURNING tpb.*,
               (SELECT is_platform_locked FROM prompt_blocks pb WHERE pb.id = tpb.prompt_block_id) AS is_platform_locked,
               (SELECT title FROM prompt_blocks pb WHERE pb.id = tpb.prompt_block_id) AS catalog_title`,
    values,
  );
  return rows[0] ?? null;
}

export async function resetTenantPromptBlockContent(
  tenantId: string,
  id: string,
): Promise<TenantPromptBlockWithMeta | null> {
  const { rows } = await pool.query<TenantPromptBlockWithMeta>(
    `UPDATE tenant_prompt_blocks tpb
     SET content = pb.default_content,
         updated_at = now()
     FROM prompt_blocks pb
     WHERE tpb.prompt_block_id = pb.id
       AND tpb.tenant_id = $1
       AND tpb.id = $2
     RETURNING tpb.*,
               pb.is_platform_locked,
               pb.title AS catalog_title`,
    [tenantId, id],
  );
  return rows[0] ?? null;
}

export async function insertCustomTenantPromptBlock(
  tenantId: string,
  input: { block_key: string; title: string; content: string; sort_order: number },
): Promise<TenantPromptBlockWithMeta> {
  const key = input.block_key.startsWith('custom_') ? input.block_key : `custom_${input.block_key}`;
  const { rows } = await pool.query<TenantPromptBlockRow>(
    `INSERT INTO tenant_prompt_blocks (tenant_id, prompt_block_id, block_key, enabled, content, sort_order)
     VALUES ($1, NULL, $2, true, $3, $4)
     RETURNING id, tenant_id, prompt_block_id, block_key, enabled, content, sort_order, created_at, updated_at`,
    [tenantId, key, input.content, input.sort_order],
  );
  const row = rows[0];
  return {
    ...row,
    is_platform_locked: false,
    catalog_title: input.title,
  };
}

export async function deleteCustomTenantPromptBlock(
  tenantId: string,
  id: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `DELETE FROM tenant_prompt_blocks
     WHERE tenant_id = $1 AND id = $2 AND prompt_block_id IS NULL`,
    [tenantId, id],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Inserts catalog blocks that are active but not yet present for a tenant.
 * Existing blocks (even customised ones) are untouched (ON CONFLICT DO NOTHING).
 * Returns the keys of every newly added block so callers can report the delta.
 */
export async function syncNewCatalogBlocksForTenant(
  tenantId: string,
): Promise<string[]> {
  const { rows } = await pool.query<{ block_key: string }>(
    `INSERT INTO tenant_prompt_blocks (tenant_id, prompt_block_id, block_key, enabled, content, sort_order)
     SELECT $1::uuid, pb.id, pb.key, true, pb.default_content, pb.sort_order
     FROM prompt_blocks pb
     WHERE pb.is_active = true
       AND NOT EXISTS (
         SELECT 1 FROM tenant_prompt_blocks tpb
         WHERE tpb.tenant_id = $1 AND tpb.block_key = pb.key
       )
     ON CONFLICT (tenant_id, block_key) DO NOTHING
     RETURNING block_key`,
    [tenantId],
  );
  return rows.map((r) => r.block_key);
}

export interface CatalogSyncTenantResult {
  tenant_id: string;
  added_block_keys: string[];
}

/**
 * Syncs active catalog blocks into the specified tenants (or all tenants when
 * tenantIds is empty / omitted). Each tenant only receives blocks it does not
 * already have — existing customisations are never touched.
 *
 * Returns one entry per tenant that had at least one block added.
 */
export async function syncNewCatalogBlocksForTenants(
  tenantIds?: string[],
): Promise<CatalogSyncTenantResult[]> {
  // Resolve the target tenant list.
  let resolvedIds: string[];
  if (!tenantIds || tenantIds.length === 0) {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM tenants ORDER BY created_at ASC');
    resolvedIds = rows.map((r) => r.id);
  } else {
    resolvedIds = tenantIds;
  }

  if (resolvedIds.length === 0) return [];

  // Single bulk INSERT for all target tenants — far more efficient than N
  // separate queries. The RETURNING clause gives us per-tenant attribution.
  const placeholders = resolvedIds.map((_, i) => `$${i + 1}::uuid`).join(', ');
  const { rows } = await pool.query<{ tenant_id: string; block_key: string }>(
    `INSERT INTO tenant_prompt_blocks (tenant_id, prompt_block_id, block_key, enabled, content, sort_order)
     SELECT t.id, pb.id, pb.key, true, pb.default_content, pb.sort_order
     FROM (SELECT unnest(ARRAY[${placeholders}]::uuid[]) AS id) t
     CROSS JOIN prompt_blocks pb
     WHERE pb.is_active = true
       AND NOT EXISTS (
         SELECT 1 FROM tenant_prompt_blocks tpb
         WHERE tpb.tenant_id = t.id AND tpb.block_key = pb.key
       )
     ON CONFLICT (tenant_id, block_key) DO NOTHING
     RETURNING tenant_id, block_key`,
    resolvedIds,
  );

  // Group results by tenant.
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.tenant_id) ?? [];
    list.push(row.block_key);
    map.set(row.tenant_id, list);
  }

  return [...map.entries()].map(([tenant_id, added_block_keys]) => ({
    tenant_id,
    added_block_keys,
  }));
}
