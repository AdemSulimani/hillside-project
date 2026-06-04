-- Structured product attributes for catalog management and AI aggregation.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS flavor       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS size         VARCHAR(255),
  ADD COLUMN IF NOT EXISTS color        VARCHAR(255),
  ADD COLUMN IF NOT EXISTS variant      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS weight       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS product_type VARCHAR(255);

CREATE INDEX IF NOT EXISTS idx_products_flavor ON products (tenant_id, flavor)
  WHERE deleted_at IS NULL AND flavor IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_products_product_type ON products (tenant_id, product_type)
  WHERE deleted_at IS NULL AND product_type IS NOT NULL;
