ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_connection_method_check;

ALTER TABLE channels
  ADD CONSTRAINT channels_connection_method_check
  CHECK (connection_method IN ('oauth_meta', 'oauth_instagram', 'manual', 'embedded_signup'));
