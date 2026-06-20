-- Adds a fingerprint schema version so the reconciliation jobs can automatically
-- re-extract richer packaging attributes (generic attribute map + per-attribute
-- confidence) from existing catalog images. Rows below CURRENT_FINGERPRINT_VERSION
-- are treated as stale and re-fingerprinted by the periodic reconcilers.
--
-- The richer attribute payload itself lives inside the existing fingerprint_json
-- JSONB column, so no per-attribute columns are required; this migration only
-- introduces the version marker used for backfill detection.

ALTER TABLE product_image_fingerprints
  ADD COLUMN IF NOT EXISTS fingerprint_version SMALLINT NOT NULL DEFAULT 1;

-- Speeds up the "find stale fingerprints to re-extract" reconciliation query.
CREATE INDEX IF NOT EXISTS idx_product_image_fingerprints_version
  ON product_image_fingerprints (tenant_id, fingerprint_version);
