-- AI Use Cases: tracks support conversations fully resolved by AI (no human intervention, no order)
-- Each completed use case is billable at the tenant's monthly volume tier rate.
-- A unique constraint on conversation_id prevents double-counting the same conversation.
CREATE TABLE IF NOT EXISTS ai_use_cases (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  UUID        NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id       UUID        NOT NULL REFERENCES contacts(id),
  status           VARCHAR(50) NOT NULL DEFAULT 'completed',
  billing_status   VARCHAR(50) NOT NULL DEFAULT 'unbilled',
  fee_amount       NUMERIC(10, 2),
  billing_period   VARCHAR(7),            -- 'YYYY-MM', set by the month-end snapshot job
  resolved_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_use_cases_status_check
    CHECK (status IN ('completed', 'voided')),
  CONSTRAINT ai_use_cases_billing_status_check
    CHECK (billing_status IN ('unbilled', 'billed', 'paid')),
  CONSTRAINT ai_use_cases_conversation_unique
    UNIQUE (conversation_id)
);

-- Fast lookup for monthly billing snapshot and tenant-facing list
CREATE INDEX IF NOT EXISTS idx_ai_use_cases_tenant_period
  ON ai_use_cases (tenant_id, billing_period, billing_status);

-- Fast lookup for tenant Credits dashboard (most-recent use cases)
CREATE INDEX IF NOT EXISTS idx_ai_use_cases_tenant_resolved
  ON ai_use_cases (tenant_id, resolved_at DESC)
  WHERE status = 'completed';
