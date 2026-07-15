-- P2-7 (RC-06 + RC-17): make a drifted multi-instance deploy DETECTABLE.
--
-- RC-06's regression-prevention text asks for "a startup assertion that all instances read
-- identical env for the frozen-at-load knobs (fail deploy on drift)". A single process cannot
-- assert that about the fleet — it can only publish what IT read and let the comparison happen
-- across instances. So each instance records a fingerprint (a hash over the module-load-frozen
-- knob values), and "more than one distinct hash live at once" IS the drift:
--
--   SELECT count(DISTINCT hash) FROM config_fingerprints
--    WHERE last_seen > now() - interval '10 min';   -- > 1 => the fleet disagrees with itself
--
-- WHY A SEPARATE TABLE, and not just a column on ai_decision_ledger.
--   1. ai_decision_ledger.tenant_id is `UUID NOT NULL REFERENCES tenants(id)`, and correlation_id /
--      idempotency_key / reply_slot / decision_kind are all NOT NULL. A fleet-level fact belongs to
--      no tenant and answers no message, so it cannot be a ledger row without weakening a NOT NULL
--      column on the busiest telemetry table.
--   2. Ledger writes are gated behind AI_DECISION_LEDGER_ENABLED (default OFF). Guard 7 would be
--      inert in every default deployment — the opposite of what a drift detector is for.
--   3. A drifted instance serving NO traffic writes no ledger rows at all, and a silent drifted
--      instance is precisely the one worth catching.
-- Hence: one row per (hash, instance), written once at boot, independent of traffic and of the
-- ledger flag.
--
-- NOT TENANT-SCOPED, deliberately — this is the one table in the schema that describes the
-- PROCESS, not a tenant's business data, so CLAUDE.md's "tenant_id on everything" rule does not
-- apply (there is no tenant to scope it to; the same config serves every tenant on the instance).
--
-- Contains NO customer data and no secrets: `knobs` holds scalar config values only, and any knob
-- marked `secret` in config/knobs.ts contributes a sha256 prefix rather than its value (so a
-- rotated secret still shows as drift without the secret landing in a table or a log).
--
-- Additive and INERT until CONFIG_FINGERPRINT_REGISTRY=true: nothing writes this table when the
-- flag is off. The always-on `[config] fingerprint=...` boot log covers the flag-off case.
CREATE TABLE IF NOT EXISTS config_fingerprints (
  -- sha256 (16 hex chars) over the sorted frozen knob set. Same config => same hash on every
  -- instance, so equality is the whole test.
  hash        TEXT NOT NULL,
  -- host:pid. Which process reported this config.
  instance    TEXT NOT NULL,
  -- The frozen knob values behind `hash`, so drift can be DIAGNOSED (which knob differs?) and not
  -- merely detected. Scalars only.
  knobs       JSONB NOT NULL,
  -- Boot time of the first process that reported this (hash, instance) pair...
  first_seen  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- ...and the most recent, which is what the drift query windows on. A restarted instance on the
  -- same config refreshes last_seen rather than adding a row.
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hash, instance)
);

-- The drift query is `WHERE last_seen > now() - interval` with no hash/instance predicate, so the
-- PK's leading column cannot serve it.
CREATE INDEX IF NOT EXISTS idx_config_fingerprints_last_seen
  ON config_fingerprints (last_seen);

-- The per-reply pointer: which config produced THIS reply.
--
-- Short form only — `{hash, instance}`, ~80 bytes — NOT the full knob set, which would duplicate a
-- per-process fact on every row. It joins to config_fingerprints for the values. This is what lets
-- an incident be reconstructed from the ledger alone (migration 073's stated design goal): once a
-- drift is known, "which replies ran on the bad config" is a single indexed lookup.
--
-- Additive, nullable, no backfill: legacy rows read NULL (fingerprint simply unavailable for that
-- turn). Carries no PII, so the P1-6 redaction pass passes it through explicitly.
ALTER TABLE ai_decision_ledger
  ADD COLUMN IF NOT EXISTS config_fingerprint JSONB;
