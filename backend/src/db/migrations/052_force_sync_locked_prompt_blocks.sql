-- Migration 052: Force-sync all platform-locked prompt blocks to every tenant.
--
-- Previous migrations (042, 043) used exact string matching to propagate catalog
-- changes to tenant_prompt_blocks rows.  Any tenant whose row didn't match the
-- expected old text verbatim (e.g. seeded at a different migration step, had
-- minor whitespace variance, or was previously edited) silently missed those
-- updates and continued operating with stale AI instructions.
--
-- This migration corrects that by performing an unconditional UPDATE for every
-- tenant row that is linked to a platform-locked block and whose content differs
-- from the current catalog default.  Tenant-customised rows on non-locked blocks
-- are never touched.

UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE tpb.prompt_block_id = pb.id
  AND pb.is_platform_locked = true
  AND tpb.content IS DISTINCT FROM pb.default_content;
