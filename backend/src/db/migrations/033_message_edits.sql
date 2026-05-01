-- Track edited inbound messages from Meta platforms (Messenger `message_edits`,
-- Instagram `message_edit`, WhatsApp Cloud API edited-message notifications).
--
-- `edited_at`        Timestamp of the most recent edit applied (NULL for never-edited rows).
-- `edit_count`       Number of edits we've recorded; capped only by what the platform delivers
--                    (Messenger limits clients to 5; WhatsApp ~15 minute window).
-- `original_content` Snapshot of `content` at the time of the first edit. Populated on the first
--                    edit and never overwritten so the inbox can always show "edited from: …".
-- `edit_history`     Append-only audit trail of prior content snapshots.
--                    Each entry shape: { content, attachment_urls, edited_at, num_edit?, source }
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS edited_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS edit_count       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS original_content TEXT,
  ADD COLUMN IF NOT EXISTS edit_history     JSONB NOT NULL DEFAULT '[]'::jsonb;
