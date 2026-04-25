ALTER TABLE products
  ADD COLUMN IF NOT EXISTS brand VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_products_tenant_brand
  ON products (tenant_id, brand)
  WHERE deleted_at IS NULL;
