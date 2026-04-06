ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sku VARCHAR(100),
  ADD COLUMN IF NOT EXISTS category VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_products_tenant_sku ON products (tenant_id, sku) WHERE deleted_at IS NULL;
