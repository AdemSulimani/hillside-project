-- P3-3 (RC-23): provenance columns on the migration ledger. Additive + idempotent.
--
-- Completes the P0-1 stop-gap. The runner fills these in a single END-OF-RUN
-- reconcile pass (db/migrate.ts), NOT at the apply-time INSERT — on a fresh DB,
-- files 001…082 are inserted BEFORE this migration creates the columns, so an
-- INSERT that referenced them would fail.
--
--   checksum    : sha256 of the migration file's bytes, frozen the first time the
--                 runner sees the applied row (apply time for new files, a one-time
--                 baseline for pre-P3-3 rows). NEVER overwritten. NULL is legal
--                 forever for orphan rows whose file was later deleted (the offers
--                 branch 063/064/065_offers*, the 026/036 dupes — EV-037). Drift
--                 detection skips NULLs and skips rows whose file is absent.
--   applied_seq : monotonic apply-order key, independent of the filename ordinal,
--                 so the historical out-of-order rows stay legal and future
--                 timestamp-named files get a real total order. Backfilled by the
--                 runner from (run_at, id); never written here.

ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS checksum    TEXT;
ALTER TABLE _migrations ADD COLUMN IF NOT EXISTS applied_seq BIGINT;

-- The runner assigns applied_seq single-writer under the migration advisory lock,
-- but guard against a double-backfill ever duplicating a key. Partial so the many
-- pre-backfill NULL rows on an existing DB don't collide before the reconcile runs.
CREATE UNIQUE INDEX IF NOT EXISTS ux_migrations_applied_seq
  ON _migrations (applied_seq) WHERE applied_seq IS NOT NULL;
