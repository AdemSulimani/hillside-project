CREATE TABLE IF NOT EXISTS conversations (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id           UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel_id           UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  status               VARCHAR(50) NOT NULL DEFAULT 'open',
  last_message_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  human_override_until TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_tenant_contact_channel
  ON conversations (tenant_id, contact_id, channel_id);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_id ON conversations (tenant_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message_at ON conversations (last_message_at DESC);
