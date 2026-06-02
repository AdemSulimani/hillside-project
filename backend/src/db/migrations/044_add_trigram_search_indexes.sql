-- Accelerate the lexical product search (searchProducts / searchProductsByCategoryOrTag).
--
-- Those queries use leading-wildcard `ILIKE '%term%'`, which a B-tree index can never
-- serve, so every term forced a sequential scan over the tenant's products. With up to
-- 10 disjunctive terms + phrases per inbound message, retrieval latency grew linearly
-- with catalog size. pg_trgm GIN indexes make unanchored ILIKE index-backed.
--
-- NOTE: created without CONCURRENTLY because the migration runner wraps each file in a
-- transaction. On an existing large table this takes a brief write lock; for very large
-- catalogs prefer building these manually with CREATE INDEX CONCURRENTLY outside a txn.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_products_name_trgm
  ON products USING gin (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_brand_trgm
  ON products USING gin (brand gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_description_trgm
  ON products USING gin (description gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_products_category_trgm
  ON products USING gin (category gin_trgm_ops);

-- tags is jsonb; the search path uses `tags::text ILIKE`, so index the text projection.
CREATE INDEX IF NOT EXISTS idx_products_tags_text_trgm
  ON products USING gin ((tags::text) gin_trgm_ops);
