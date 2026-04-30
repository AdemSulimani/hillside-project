-- Configurable per-tenant delivery time used by the AI when answering delivery ETA queries.
-- Allowed values: '24h', '48h', '72h'. NULL means the tenant has not configured it yet.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS delivery_time VARCHAR(10);

ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS tenants_delivery_time_check;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_delivery_time_check
  CHECK (delivery_time IS NULL OR delivery_time IN ('24h', '48h', '72h'));
