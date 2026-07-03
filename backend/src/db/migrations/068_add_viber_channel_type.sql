-- Add Viber as a supported channel type and viber_bot as a connection method.
-- Uses conditional DROP/ADD of the CHECK constraint because PostgreSQL does not support
-- ALTER ... CHECK ... ADD VALUE like enum types do.

DO $$
BEGIN
  -- Drop the existing type constraint so we can re-create it with 'viber' included.
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_type_check'
  ) THEN
    ALTER TABLE channels DROP CONSTRAINT channels_type_check;
  END IF;

  ALTER TABLE channels
    ADD CONSTRAINT channels_type_check
    CHECK (type IN ('facebook', 'instagram', 'whatsapp', 'viber'));

  -- Drop and re-create the connection_method constraint with 'viber_bot' included.
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_connection_method_check'
  ) THEN
    ALTER TABLE channels DROP CONSTRAINT channels_connection_method_check;
  END IF;

  ALTER TABLE channels
    ADD CONSTRAINT channels_connection_method_check
    CHECK (connection_method IN ('oauth_meta', 'oauth_instagram', 'manual', 'embedded_signup', 'viber_bot'));
END $$;
