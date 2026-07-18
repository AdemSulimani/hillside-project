-- P3-5 (RC-26/RC-25/RC-17): the immutable prompt-block version registry.
--
-- THE DEFECT. Prompt content is the model's entire behavioural surface, and today it has no
-- history at all. Catalog content is mutated by `adminAiController.updateCatalogBlock` with no
-- record of the previous value (`recordAiVersion` snapshots TENANT rows only, never
-- `prompt_blocks.default_content`), and by 19 prompt-mutating migrations whose inverse does not
-- exist -- `migrateDown.ts` says so in as many words: "the inverse of a data/prompt change is
-- 'the previous content', which lives in the P3-5 registry, not here". So no reply can be traced
-- to the block text that produced it, and no prompt change can be rolled back.
--
-- CONTENT-ADDRESSED, not ordinal-versioned. The reply path renders blocks out of a Redis cache
-- (aiService.loadTenantPromptBlocksCached). An ordinal recorded ALONGSIDE cached content can
-- confidently describe content that was never sent -- that is RC-17's drift laundered into the
-- audit trail. A hash is derived from the bytes actually rendered, so it cannot be stale relative
-- to them. It also dedups: 6 tenants x 12 locked blocks are near-identical by construction
-- (forceSyncLockedBlocksForTenants makes them so), collapsing ~72 rows to ~12.
--
-- `version` is a monotonic per-key HUMAN LABEL ("v7 of guidelines.order_flow_and_escalation"),
-- never the identity. Two tenants can hold different content for one key concurrently and neither
-- is "newer"; an ordinal-as-identity design has no honest answer there. Do not build tooling on it.
--
-- PK is the (block_key, content_hash) PAIR, not the hash alone: two keys may legitimately hold
-- identical text (a tenant copies a guideline into a custom_* block), and collapsing them would
-- make "which key produced this hash" ambiguous.
--
-- NO tenant_id. A version is a CONTENT fact; which tenants use it is a `tenant_prompt_blocks`
-- fact. Adding it would re-fragment the dedup this table exists for. Unlike `ai_prompt_blobs`
-- (which carries an assembled prompt including catalog rows and a customer-derived preview, hence
-- its tenant scoping and retention sweep), block content is platform/operator-authored and
-- carries no customer text -- so there is also nothing here to redact.
--
-- NEVER PRUNED. Ledger rows point at these hashes, and superseded versions exist nowhere else
-- (the backfill can only reconstruct what is live now), so retention is the whole point.
--
-- A paired .down.sql EXISTS despite that, and the reasoning is in it: `runDown` reverts from the
-- top of the stack, so an irreversible tip permanently blocks reverting every migration beneath
-- it. Paying that forever — on every future structural change — to protect a table only
-- `MIGRATE_ALLOW_DOWN=1` can reach is the wrong trade. The down file documents what it destroys.

CREATE TABLE IF NOT EXISTS prompt_block_versions (
  block_key VARCHAR(128) NOT NULL,
  -- sha256 hex over the content's UTF-8 bytes. Must equal Node's
  -- `createHash('sha256').update(content).digest('hex')` -- see the backfill note below.
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  -- backfill | admin_catalog | admin_tenant | reconcile
  source VARCHAR(32) NOT NULL,
  created_by_email VARCHAR(255),
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (block_key, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_block_versions_key_version
  ON prompt_block_versions (block_key, version);
CREATE INDEX IF NOT EXISTS idx_prompt_block_versions_hash
  ON prompt_block_versions (content_hash);
CREATE INDEX IF NOT EXISTS idx_prompt_block_versions_last_seen
  ON prompt_block_versions (last_seen);

-- REGISTRY v1 -- a faithful snapshot of what is live RIGHT NOW, so enabling the feature changes
-- zero prompt bytes and the rollback story ("v1 is the current content") is literally true.
--
-- Sourced from BOTH sides: `prompt_blocks.default_content` is what the catalog intends, but
-- `tenant_prompt_blocks.content` is what actually renders -- and they diverge (unlocked blocks are
-- admin-customisable per tenant, and the older exact-string migration syncs are known to have
-- missed rows, which is why migration 052 exists). Registering only the catalog would leave the
-- text most replies actually used unregistered.
--
-- `convert_to(content, 'UTF8')` is load-bearing, NOT decoration. pgcrypto's digest(text, ...)
-- hashes the string in the DATABASE's server encoding, while Node hashes UTF-8. Every guideline
-- block here is Albanian (e, c) and the platform rulebook is full of EUR signs, so on a non-UTF8
-- server_encoding a bare digest(content, 'sha256') would give essentially EVERY row a hash the
-- runtime never reproduces -- 100% phantom "unknown hash", poisoning the exact alarm this table
-- exists to raise. convert_to pins the byte sequence regardless of server encoding.
--
-- The reconcile sweep re-verifies every stored hash in Node and is the authority; this backfill is
-- the fast path that makes the registry non-empty at deploy time.
-- The catalog's own `default_content` takes v1 for each key (it is the intended text); tenant
-- variants that diverge from it follow, ordered by hash purely for determinism -- a re-run on a
-- restored snapshot must assign identical labels. `version` is a label, so an arbitrary-but-stable
-- order among equals is the correct amount of meaning to give it.
INSERT INTO prompt_block_versions
  (block_key, content_hash, version, content, char_count, source)
SELECT
  s.block_key,
  s.content_hash,
  row_number() OVER (
    PARTITION BY s.block_key
    ORDER BY s.is_catalog DESC, s.content_hash
  ) AS version,
  s.content,
  length(s.content),
  'backfill'
FROM (
  SELECT
    b.block_key,
    encode(digest(convert_to(b.content, 'UTF8'), 'sha256'), 'hex') AS content_hash,
    b.content,
    bool_or(b.is_catalog) AS is_catalog
  FROM (
    SELECT key AS block_key, default_content AS content, true AS is_catalog FROM prompt_blocks
    UNION ALL
    SELECT block_key, content, false FROM tenant_prompt_blocks
  ) b
  WHERE b.content IS NOT NULL AND b.content <> ''
  GROUP BY b.block_key, b.content
) s
ON CONFLICT (block_key, content_hash) DO NOTHING;
