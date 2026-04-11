CREATE TABLE IF NOT EXISTS analytics_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type   VARCHAR(100) NOT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE analytics_events IS 'Append-only analytics event log; application code must only INSERT.';

CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant_occurred
  ON analytics_events (tenant_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant_type_occurred
  ON analytics_events (tenant_id, event_type, occurred_at DESC);
