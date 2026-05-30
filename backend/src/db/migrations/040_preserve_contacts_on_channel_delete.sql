-- Preserve contacts (and their conversations, orders, use cases, commission data) when a
-- social account / channel is disconnected.
--
-- contacts.channel_id previously had ON DELETE CASCADE, so removing a channel wiped every
-- linked contact, which then cascade-deleted conversations → orders → ai_use_cases,
-- destroying all commission history even though conversations.channel_id was already fixed
-- to ON DELETE SET NULL in migration 039.
--
-- Fix: make contacts.channel_id nullable and switch to ON DELETE SET NULL so contact
-- records (and everything attached to them) survive a channel deletion.

-- 1. Allow NULL
ALTER TABLE contacts
  ALTER COLUMN channel_id DROP NOT NULL;

-- 2. Drop whatever FK constraint currently links contacts.channel_id → channels.id
--    (uses the catalogue so it works regardless of the auto-generated constraint name)
DO $$
DECLARE
  fk_name text;
BEGIN
  FOR fk_name IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid  = 'contacts'::regclass
      AND confrelid = 'channels'::regclass
      AND contype   = 'f'
  LOOP
    EXECUTE format('ALTER TABLE contacts DROP CONSTRAINT %I', fk_name);
  END LOOP;
END $$;

-- 3. Re-add with SET NULL
ALTER TABLE contacts
  ADD CONSTRAINT contacts_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL;
