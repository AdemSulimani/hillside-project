-- Reverse of 083 (P3-3). Reversible: drops only the additive provenance columns
-- and their index. Excluded from the forward scan by the `.down.sql` suffix; run
-- only via `npm run migrate:down` (MIGRATE_ALLOW_DOWN=1). After this the runner
-- degrades gracefully — it re-detects the missing columns and skips provenance.
DROP INDEX IF EXISTS ux_migrations_applied_seq;
ALTER TABLE _migrations DROP COLUMN IF EXISTS applied_seq;
ALTER TABLE _migrations DROP COLUMN IF EXISTS checksum;
