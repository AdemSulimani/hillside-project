CREATE TABLE IF NOT EXISTS ai_configs (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID        NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  tone                  VARCHAR(255) NOT NULL DEFAULT 'professional',
  personality_description TEXT,
  restrictions          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  sales_strategy        TEXT,
  objection_handling    TEXT,
  qa_pairs              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  is_active             BOOLEAN     NOT NULL DEFAULT true,
  custom_model_id       VARCHAR(255),
  feedback_count        INTEGER     NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_configs_tenant_id ON ai_configs (tenant_id);
