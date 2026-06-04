-- ai_config_versions may exist from a pre-036 legacy shape (version_number,
-- change_note, created_by_admin_id). Migration 036 used CREATE TABLE IF NOT EXISTS,
-- so some databases never received note / created_by_email.
-- Fresh installs already have note / created_by_email from 036; only legacy DBs
-- need the data copy and column drops below.

ALTER TABLE ai_config_versions
  ADD COLUMN IF NOT EXISTS note TEXT,
  ADD COLUMN IF NOT EXISTS created_by_email VARCHAR(255);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'ai_config_versions'
      AND column_name = 'change_note'
  ) THEN
    EXECUTE $migrate$
      UPDATE ai_config_versions
      SET note = change_note
      WHERE note IS NULL
        AND change_note IS NOT NULL
    $migrate$;
  END IF;
END $$;

ALTER TABLE ai_config_versions
  DROP COLUMN IF EXISTS version_number,
  DROP COLUMN IF EXISTS change_note,
  DROP COLUMN IF EXISTS created_by_admin_id;
