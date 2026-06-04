-- Visual fingerprints for catalog product images (used for customer photo → product matching).
-- Each row stores a vision-extracted description + embedding vector for one image URL.

CREATE TABLE IF NOT EXISTS product_image_fingerprints (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  product_id            UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  image_url             TEXT NOT NULL,
  image_url_hash        TEXT NOT NULL,
  fingerprint_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
  fingerprint_text      TEXT NOT NULL DEFAULT '',
  embedding             vector(1536),
  embedding_input_hash  TEXT,
  embedding_model       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_product_image_fingerprint_url UNIQUE (tenant_id, image_url_hash)
);

CREATE INDEX IF NOT EXISTS idx_pif_tenant_product
  ON product_image_fingerprints (tenant_id, product_id);

CREATE INDEX IF NOT EXISTS idx_pif_embedding_hnsw
  ON product_image_fingerprints USING hnsw (embedding vector_cosine_ops)
  WHERE embedding IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pif_missing_embedding
  ON product_image_fingerprints (tenant_id, updated_at DESC)
  WHERE embedding IS NULL;
