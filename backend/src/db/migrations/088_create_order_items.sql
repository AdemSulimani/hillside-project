-- 088_create_order_items.sql
--
-- Multi-product orders. Until now an order held exactly one product in flat columns on the
-- `orders` row (014_create_orders.sql), so a customer ordering two products had only the first
-- registered. This adds a normalized child table so an order can carry N line items.
--
-- The `orders` header row is KEPT and redefined as a maintained mirror: its product_id/product_name/
-- unit_price track the "primary line" (highest line total), while quantity/total_price/commission_amount
-- are the SUM across lines. Every existing single-product reader (list, detail, confirm, cancel,
-- credits, commission billing) keeps working unchanged; for a single-line order the header is
-- byte-identical to today. Idempotent (re-runs at every boot; safe after a partial failure).

CREATE TABLE IF NOT EXISTS order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id)   ON DELETE CASCADE,
  tenant_id     UUID NOT NULL REFERENCES tenants(id)  ON DELETE CASCADE,
  product_id    UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name  VARCHAR(512) NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_price   NUMERIC(12, 2) NOT NULL DEFAULT 0,
  item_index    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id  ON order_items (order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_tenant_id ON order_items (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_order_index ON order_items (order_id, item_index);

-- Backfill one line per existing order, mirroring its current single-product columns. Idempotent:
-- the NOT EXISTS guard means a re-run (or a boot after this migration already applied) inserts nothing.
INSERT INTO order_items (order_id, tenant_id, product_id, product_name, quantity, unit_price, total_price, item_index)
SELECT o.id, o.tenant_id, o.product_id, o.product_name, o.quantity, o.unit_price, o.total_price, 0
FROM orders o
WHERE NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id);
