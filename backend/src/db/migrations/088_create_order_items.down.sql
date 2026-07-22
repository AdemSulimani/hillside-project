-- Reverts 088_create_order_items.sql.
--
-- Safe ONLY before multi-item order creation is enabled in production: dropping the table discards
-- any secondary lines. Single-product orders lose nothing — the header row retains the primary line.
-- Guarded DROPs so the down migration is itself idempotent.

DROP INDEX IF EXISTS idx_order_items_order_index;
DROP INDEX IF EXISTS idx_order_items_tenant_id;
DROP INDEX IF EXISTS idx_order_items_order_id;
DROP TABLE IF EXISTS order_items;
