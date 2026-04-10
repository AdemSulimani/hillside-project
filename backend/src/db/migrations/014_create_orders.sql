CREATE TABLE IF NOT EXISTS orders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id        UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  product_id        UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name      VARCHAR(512) NOT NULL,
  quantity          INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_price       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status            VARCHAR(50) NOT NULL DEFAULT 'draft',
  customer_name     VARCHAR(512) NOT NULL,
  customer_phone    VARCHAR(50),
  delivery_address  TEXT,
  notes             TEXT,
  detected_by       VARCHAR(50) NOT NULL DEFAULT 'ai',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_id ON orders (tenant_id);
CREATE INDEX IF NOT EXISTS idx_orders_tenant_status ON orders (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_conversation_id ON orders (conversation_id);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders (created_at DESC);
