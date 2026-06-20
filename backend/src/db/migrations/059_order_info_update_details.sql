-- Add structured details column to ai_alerts for richer audit trails.
-- Used primarily by the order-info-update flow to record which fields changed,
-- their previous values, new values, and the associated order_id.
ALTER TABLE ai_alerts
  ADD COLUMN IF NOT EXISTS details JSONB DEFAULT NULL;
