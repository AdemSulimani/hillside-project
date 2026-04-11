CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE products ADD COLUMN IF NOT EXISTS embedding vector(768);

CREATE INDEX IF NOT EXISTS idx_products_embedding
  ON products USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL AND deleted_at IS NULL;
