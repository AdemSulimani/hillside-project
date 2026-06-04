-- ai_config_versions may exist from a pre-036 legacy shape (version_number,
-- change_note, created_by_admin_id). Migration 036 used CREATE TABLE IF NOT EXISTS,
-- so those databases never received note / created_by_email.

ALTER TABLE ai_config_versions
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS created_by_email VARCHAR(255);

UPDATE ai_config_versions
SET note = change_note
WHERE note IS NULL
  AND change_note IS NOT NULL;

ALTER TABLE ai_config_versions
  DROP COLUMN IF EXISTS version_number,
  DROP COLUMN IF EXISTS change_note,
  DROP COLUMN IF EXISTS created_by_admin_id;
