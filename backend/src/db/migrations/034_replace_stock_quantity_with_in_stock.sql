-- Replace numeric stock_quantity with a simple in-stock flag.
-- Legacy: NULL stock_quantity meant unspecified — treat as in stock.
-- Zero quantity is treated as out of stock.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS in_stock BOOLEAN NOT NULL DEFAULT true;

UPDATE products
SET in_stock = (stock_quantity IS NULL OR stock_quantity > 0);

ALTER TABLE products DROP COLUMN IF EXISTS stock_quantity;
