CREATE TABLE IF NOT EXISTS feedback_logs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id             UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id        UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  original_ai_response   TEXT NOT NULL,
  corrected_response     TEXT,
  reason                 VARCHAR(2000),
  status                 VARCHAR(50) NOT NULL DEFAULT 'pending',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_logs_tenant_id ON feedback_logs (tenant_id);
CREATE INDEX IF NOT EXISTS idx_feedback_logs_tenant_status_created
  ON feedback_logs (tenant_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_logs_message_id ON feedback_logs (message_id);
