-- Composite indexes for hot tenant-scoped queries (IF NOT EXISTS keeps re-runs safe).

CREATE INDEX IF NOT EXISTS idx_messages_tenant_conversation_created
  ON messages (tenant_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_tenant_last_message
  ON conversations (tenant_id, last_message_at DESC);

-- contacts: unique index idx_contacts_tenant_channel_external_id already covers (tenant_id, channel_id, external_id).
-- orders: idx_orders_tenant_status already covers (tenant_id, status).
-- analytics_events: idx_analytics_events_tenant_type_occurred already covers (tenant_id, event_type, occurred_at DESC).
