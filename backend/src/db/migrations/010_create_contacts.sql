CREATE TABLE IF NOT EXISTS contacts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id VARCHAR(255) NOT NULL,
  name        VARCHAR(255) NOT NULL,
  avatar_url  VARCHAR(1024),
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_tenant_channel_external_id
  ON contacts (tenant_id, channel_id, external_id);

CREATE INDEX IF NOT EXISTS idx_contacts_tenant_id ON contacts (tenant_id);
CREATE INDEX IF NOT EXISTS idx_contacts_channel_id ON contacts (channel_id);
