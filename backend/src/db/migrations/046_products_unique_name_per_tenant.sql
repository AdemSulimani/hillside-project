-- Prevent duplicate products when a tenant re-uploads a spreadsheet or PDF.
--
-- Step 1: Resolve existing duplicates (common after repeated bulk imports).
-- For each (tenant_id, normalized name) group we keep ONE row and soft-delete
-- the rest. Preference order:
--   1. Row that already has an embedding (semantic search still works)
--   2. Most recently updated (likely the latest import data)
--   3. Newest created_at / id as tie-breaker
--
-- Step 2: Add the partial unique index so future imports upsert instead of
-- duplicating.

WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY tenant_id, LOWER(TRIM(name))
      ORDER BY
        (embedding IS NOT NULL) DESC,
        updated_at DESC NULLS LAST,
        created_at DESC,
        id DESC
    ) AS rn
  FROM products
  WHERE deleted_at IS NULL
)
UPDATE products p
SET
  deleted_at = now(),
  updated_at = now(),
  is_active  = false
FROM ranked r
WHERE p.id = r.id
  AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_products_tenant_name_unique
  ON products (tenant_id, LOWER(TRIM(name)))
  WHERE deleted_at IS NULL;
