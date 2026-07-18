-- P3-5 (RC-26): remove the orphan `guidelines.offers_promotions` prompt block.
--
-- WHAT IT IS. An admin-created block present in NO migration, sitting in `prompt_blocks` with
-- `is_active = false` — yet `enabled = true` on all 6 tenant rows, because
-- `listTenantPromptBlocksRuntime` never joins `prompt_blocks` and so never consults the catalog's
-- own active flag at render time. The result is ~1,478 chars in every tenant's every prompt
-- instructing the model to answer from an "Active offers and promotions" section that the code
-- does not populate and never has. The model is told a nonexistent section is "the ONLY source of
-- truth about offers" — so the honest outcomes are invented offers or confused refusals.
--
-- WHY A DELETE AND NOT JUST THE ALLOWLIST. P2-5's render-time allowlist already drops this key,
-- and P3-5 now alerts on it. But that is a GUARD, not a fix: it holds only while
-- PROMPT_ALLOWLIST_BUDGET is on, and the rows underneath are still `enabled = true`. Removing the
-- data is what makes the allowlist a backstop instead of a life-support machine.
--
-- WHY IT IS SAFE TO DELETE NOW, and was not before. Migration 084 records every distinct block
-- content in `prompt_block_versions`, so this text survives deletion (v1, 1,478 chars,
-- content-addressed) and stays resolvable from the `prompt.blocks[].hash` in any historical
-- `ai_decision_ledger` row. Before 084 this delete would have destroyed the only copy. The
-- guarded DELETEs below make that dependency ENFORCED rather than assumed: if the registry does
-- not already hold this content, they delete nothing.
--
-- Two further checks were run against the live data before writing this, both of which had to
-- hold or the delete would have been unsafe:
--   1. `extractConfigGroundTruthPrices` extracts ZERO prices from this block. Block text feeds the
--      hallucination guard's price reference set, and narrowing that set WIDENS escalation — the
--      "side effect at a distance in a safety path" P2-5 recorded as its reason for not fixing the
--      is_active join. This block contributes nothing to it, so removing it cannot widen anything.
--   2. The registry holds exactly ONE version for this key, i.e. all 6 tenant copies are byte-
--      identical to the catalog default. No tenant had customised it, so no tenant loses work.
--
-- BEHAVIOUR CHANGE, stated plainly: this shortens the assembled prompt by ~1,480 chars for 6/6
-- tenants. That is the intended correction — the removed text refers to a section that does not
-- exist, so nothing can depend on it.
--
-- NO PAIRED .down.sql, deliberately. This is a DATA migration, and the repo's rule is that the
-- inverse of a data/prompt change is "the previous content", which lives in the P3-5 registry
-- rather than in a down file. To restore: re-insert from `prompt_block_versions` where
-- `block_key = 'guidelines.offers_promotions'`.

-- Tenant copies first: `tenant_prompt_blocks.prompt_block_id` is ON DELETE RESTRICT, so the
-- catalog row cannot go while any tenant row still points at it. Matched on the key AND the FK so
-- a hand-made row with a NULL `prompt_block_id` is caught too.
DELETE FROM tenant_prompt_blocks tpb
 WHERE (
         tpb.block_key = 'guidelines.offers_promotions'
         OR tpb.prompt_block_id IN (SELECT id FROM prompt_blocks WHERE key = 'guidelines.offers_promotions')
       )
   AND EXISTS (
         SELECT 1 FROM prompt_block_versions
          WHERE block_key = 'guidelines.offers_promotions'
       );

-- Then the catalog row, and only while it is still inactive: an admin who has deliberately
-- re-activated this block since has made a decision this migration should not silently reverse.
DELETE FROM prompt_blocks pb
 WHERE pb.key = 'guidelines.offers_promotions'
   AND pb.is_active = false
   AND EXISTS (
         SELECT 1 FROM prompt_block_versions
          WHERE block_key = 'guidelines.offers_promotions'
       );
