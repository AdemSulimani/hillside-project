ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS refund_reason TEXT,
  ADD COLUMN IF NOT EXISTS cancellation_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS refund_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_status VARCHAR(50),
  ADD COLUMN IF NOT EXISTS resolution_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_tenant_resolution_status
  ON orders (tenant_id, resolution_status);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_cancellation_requested_at
  ON orders (tenant_id, cancellation_requested_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_tenant_refund_requested_at
  ON orders (tenant_id, refund_requested_at DESC);
