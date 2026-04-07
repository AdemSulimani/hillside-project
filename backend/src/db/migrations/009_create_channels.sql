CREATE TABLE IF NOT EXISTS channels (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type                   VARCHAR(50) NOT NULL CHECK (type IN ('facebook', 'instagram', 'whatsapp')),
  name                   VARCHAR(255) NOT NULL,
  external_id            VARCHAR(255) NOT NULL,
  access_token_encrypted TEXT NOT NULL,
  webhook_verified       BOOLEAN NOT NULL DEFAULT false,
  ai_enabled             BOOLEAN NOT NULL DEFAULT true,
  metadata               JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_tenant_type_external_id
  ON channels (tenant_id, type, external_id);

CREATE INDEX IF NOT EXISTS idx_channels_tenant_id ON channels (tenant_id);
CREATE INDEX IF NOT EXISTS idx_channels_external_id ON channels (external_id);
