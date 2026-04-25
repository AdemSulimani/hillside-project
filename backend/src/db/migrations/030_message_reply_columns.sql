-- Thread reply metadata (e.g. Instagram DM reply-to-message)
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_message_id UUID REFERENCES messages (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reply_to_external_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS reply_to_content TEXT,
  ADD COLUMN IF NOT EXISTS reply_to_attachment_url VARCHAR(2048);

CREATE INDEX IF NOT EXISTS idx_messages_reply_to_message_id ON messages (reply_to_message_id)
  WHERE reply_to_message_id IS NOT NULL;
