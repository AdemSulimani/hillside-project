-- Conversation flags for AI-only vs human-touched threads
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS fully_ai_handled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS human_replied BOOLEAN NOT NULL DEFAULT false;

-- Order commission fields (commission_amount set when order is AI-created while thread had no human reply)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(12, 2),
  ADD COLUMN IF NOT EXISTS is_commissionable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS commission_status VARCHAR(50) NOT NULL DEFAULT 'unpaid';

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_commission_status_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_commission_status_check
  CHECK (commission_status IN ('unpaid', 'billed', 'paid'));

CREATE INDEX IF NOT EXISTS idx_orders_tenant_commission
  ON orders (tenant_id, is_commissionable, commission_status)
  WHERE is_commissionable = true;

-- Platform owner accounts (separate from tenant users)
CREATE TABLE IF NOT EXISTS platform_owners (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email          VARCHAR(320) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_platform_owners_email ON platform_owners (email);

-- Saved commission billing periods per tenant
CREATE TABLE IF NOT EXISTS commission_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start       DATE NOT NULL,
  period_end         DATE NOT NULL,
  total_orders       INTEGER NOT NULL DEFAULT 0,
  total_revenue      NUMERIC(14, 2) NOT NULL DEFAULT 0,
  commission_amount  NUMERIC(14, 2) NOT NULL DEFAULT 0,
  status             VARCHAR(50) NOT NULL DEFAULT 'unpaid',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commission_reports_status_check CHECK (status IN ('unpaid', 'billed', 'paid')),
  CONSTRAINT commission_reports_period_order CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_commission_reports_tenant ON commission_reports (tenant_id, created_at DESC);
