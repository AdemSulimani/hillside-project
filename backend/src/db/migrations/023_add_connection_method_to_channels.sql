ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS connection_method VARCHAR(50) NOT NULL DEFAULT 'oauth_meta';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'channels_connection_method_check'
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_connection_method_check
      CHECK (connection_method IN ('oauth_meta', 'oauth_instagram', 'manual'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_channels_connection_method
  ON channels (connection_method);
