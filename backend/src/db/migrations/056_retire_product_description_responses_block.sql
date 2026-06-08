-- Migration 056: Retire the redundant guidelines.product_description_responses block.
--
-- Problem: Migration 050 introduced guidelines.product_description_responses
-- (sort_order 75) whose content is almost identical to the concise-description
-- rules that 050 also added to guidelines.recommendations (sort_order 80).
-- The two blocks sit adjacent in every assembled system prompt and repeat the
-- same instructions (1-2 short lines per product, never paste full description,
-- etc.), wasting prompt tokens without any behavioral benefit.
--
-- Since guidelines.recommendations already carries the full set of concise-
-- description rules, guidelines.product_description_responses is redundant.
--
-- Fix:
--   1. Disable the block for every existing tenant so it is no longer included
--      in assembled system prompts.
--   2. Mark the catalog record inactive so future tenant seeding does not
--      re-introduce it.
--
-- Note: rows are kept (not deleted) so the data is recoverable and existing
-- foreign-key references remain valid.
--
-- Safety net: re-run the guidelines.recommendations exact-string sync from
-- migration 050 to catch any tenants that may have missed it (e.g. the 050
-- migration ran but the sync failed partway through).  This is a no-op for
-- tenants already on the current content.

-- 1. Disable for all existing tenant blocks.
UPDATE tenant_prompt_blocks tpb
SET
  enabled    = false,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key               = 'guidelines.product_description_responses'
  AND tpb.prompt_block_id  = pb.id
  AND tpb.enabled          = true;

-- 2. Mark catalog record inactive so new-tenant seeding skips it.
UPDATE prompt_blocks
SET
  is_active  = false,
  updated_at = now()
WHERE key = 'guidelines.product_description_responses';

-- 3. Safety-net re-sync for guidelines.recommendations (no-op for already-updated tenants).
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key               = 'guidelines.recommendations'
  AND tpb.prompt_block_id  = pb.id
  AND tpb.content = $old$
- Exception — when the customer asks for recommendations, which product to choose/compare, or product suggestions for a specific situation or need: suggest only 1-2 products from the catalog (never more than two).
- For each of those products, add a very short description using only what appears in that product's catalog entry (one tight phrase or sentence per product; trim the catalog text if needed — do not invent details).
- For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add a follow-up question, invitation, "let me know" prompt, or any closing prompt — the only exception is the single allowed order-oriented follow-up question on the very first product turn (at most one short sentence).
- In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
- In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.
$old$;
