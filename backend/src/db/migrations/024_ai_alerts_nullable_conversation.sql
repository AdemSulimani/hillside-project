-- System-level AI alerts (e.g. Meta token refresh) may not be tied to a conversation.
ALTER TABLE ai_alerts
  ALTER COLUMN conversation_id DROP NOT NULL,
  ALTER COLUMN message_id DROP NOT NULL;
