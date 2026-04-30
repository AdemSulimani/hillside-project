-- Optional discounted price per product. When set, the AI offers this as the maximum
-- discount when the customer asks for a price reduction. NULL means no discount available.
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS discounted_price NUMERIC(10,2);

ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_discounted_price_check;

ALTER TABLE products
  ADD CONSTRAINT products_discounted_price_check
  CHECK (
    discounted_price IS NULL
    OR (discounted_price >= 0 AND discounted_price < price)
  );
