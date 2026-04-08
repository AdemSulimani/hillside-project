CREATE TABLE IF NOT EXISTS messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id     UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  external_message_id VARCHAR(255) NOT NULL UNIQUE,
  direction           VARCHAR(20) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  type                VARCHAR(20) NOT NULL CHECK (type IN ('text', 'image', 'audio', 'video', 'document')),
  content             TEXT,
  attachment_urls     JSONB NOT NULL DEFAULT '[]'::jsonb,
  sent_by             VARCHAR(20) NOT NULL CHECK (sent_by IN ('customer', 'ai', 'human')),
  ai_processed        BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_tenant_id ON messages (tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at DESC);
