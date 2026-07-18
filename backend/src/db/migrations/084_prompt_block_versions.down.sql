-- Reverse of 084_prompt_block_versions.sql.
--
-- WHAT THIS DESTROYS, stated plainly because it is not recoverable by re-applying 084: the
-- registry accumulates SUPERSEDED prompt-block content. 084's backfill can only reconstruct what
-- is live right now, so every version of a block that has since been edited exists ONLY here.
-- Dropping the table also leaves the `prompt.blocks[].hash` values in existing `ai_decision_ledger`
-- rows pointing at nothing — the rows stay valid, but "what exactly produced this reply" stops
-- being answerable for the window they cover.
--
-- It is nonetheless PAIRED, deliberately. `runDown` reverts from the top of the stack, so an
-- irreversible tip permanently blocks reverting everything beneath it — a cost paid by every
-- future structural migration, forever, to protect a table that only `MIGRATE_ALLOW_DOWN=1` can
-- reach and that production rollback ("re-deploy the previous tag") never touches. Trading a
-- permanent constraint for a guarded, opt-in, non-production one is the wrong way round.
--
-- Prefer fix-forward. If you need the schema gone but the history kept, dump the table first.

DROP INDEX IF EXISTS idx_prompt_block_versions_last_seen;
DROP INDEX IF EXISTS idx_prompt_block_versions_hash;
DROP INDEX IF EXISTS uq_prompt_block_versions_key_version;
DROP TABLE IF EXISTS prompt_block_versions;
