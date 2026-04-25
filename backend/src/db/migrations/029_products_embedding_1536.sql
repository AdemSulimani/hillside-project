DROP INDEX IF EXISTS idx_products_embedding;

ALTER TABLE products DROP COLUMN IF EXISTS embedding;
ALTER TABLE products ADD COLUMN embedding vector(1536);

CREATE INDEX IF NOT EXISTS idx_products_embedding
  ON products USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND deleted_at IS NULL;
