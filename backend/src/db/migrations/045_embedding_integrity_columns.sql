-- Embedding integrity: track the exact text that was embedded plus the model version.
--
-- Problems this solves:
-- 1. usage_description updates did not re-trigger embeddings — the change-detection
--    list in productController omitted that field, so "how do I use X?" semantic
--    matching silently drifted stale after any usage update.
-- 2. If the embedding model ever changes (e.g. text-embedding-3-small → large), there
--    is no way to identify which rows need re-embedding; old and new vectors become
--    numerically incomparable without a version marker.
-- 3. There is no way to reconcile drifted embeddings other than a full re-embed.
--
-- embedding_input_hash:  SHA-256 (hex) of the text passed to buildProductText().
--                        NULL means "no embedding yet" or "hash not yet captured".
-- embedding_model:       The OPENAI_EMBEDDING_MODEL value used to generate the vector.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS embedding_input_hash TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model      TEXT;

-- Partial index for the reconciliation query: find rows where the stored hash differs
-- from a freshly computed hash, or where no embedding exists yet.
CREATE INDEX IF NOT EXISTS idx_products_embedding_stale
  ON products (tenant_id, id)
  WHERE deleted_at IS NULL
    AND is_active = true
    AND (embedding IS NULL OR embedding_input_hash IS NULL);
