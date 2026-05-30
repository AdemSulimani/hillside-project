-- Preserve conversations (and their orders / use cases / commission data) when a social
-- account is disconnected.
--
-- Previously conversations.channel_id had ON DELETE CASCADE, so removing a channel
-- wiped every linked conversation, order, AI use case and commission record.
--
-- Fix: make channel_id nullable and switch to ON DELETE SET NULL so conversations
-- (and all their billing history) survive a channel deletion intact.

-- 1. Allow NULL so we can SET NULL instead of CASCADE
ALTER TABLE conversations
  ALTER COLUMN channel_id DROP NOT NULL;

-- 2. Drop whatever FK constraint currently links conversations.channel_id → channels.id
--    (handles any auto-generated constraint name, not just the conventional one)
DO $$
DECLARE
  fk_name text;
BEGIN
  FOR fk_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid  = 'conversations'::regclass
      AND confrelid = 'channels'::regclass
      AND contype   = 'f'
  LOOP
    EXECUTE format('ALTER TABLE conversations DROP CONSTRAINT %I', fk_name);
  END LOOP;
END $$;

-- 3. Re-add the FK with SET NULL so channel deletion orphans the row instead of deleting it
ALTER TABLE conversations
  ADD CONSTRAINT conversations_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;
