-- AI reply quality scoring and owner alerts
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS quality_score NUMERIC(4, 3),
  ADD COLUMN IF NOT EXISTS flagged BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS flag_reason VARCHAR(50);

COMMENT ON COLUMN messages.quality_score IS 'Evaluator score 0.0–1.0 for AI-generated messages';
COMMENT ON COLUMN messages.flagged IS 'True when reply failed quality / relevance checks';
COMMENT ON COLUMN messages.flag_reason IS 'off_topic | unclear | irrelevant | misleading | low_confidence';

CREATE TABLE IF NOT EXISTS ai_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id       UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reason           VARCHAR(100) NOT NULL,
  status           VARCHAR(20) NOT NULL DEFAULT 'unread'
    CHECK (status IN ('unread', 'read', 'resolved')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_alerts_tenant_created ON ai_alerts (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_alerts_tenant_status ON ai_alerts (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_alerts_conversation ON ai_alerts (conversation_id);
