-- Migration 054: Narrow the escalation guideline in the category_product_aggregation block.
--
-- Problem fixed: Migration 049 introduced this guideline line:
--   "If the catalog lacks enough information to answer with high confidence,
--    do NOT guess — say a specialist will follow up (the system handles escalation)."
--
-- "Catalog lacks enough information" is ambiguous — it covers two distinct cases:
--   (a) A matching product EXISTS in the catalog but a specific attribute/technical
--       detail is missing (e.g. ingredients list, exact weight).  Here escalation may
--       be warranted because we have the product but lack the data.
--   (b) The product does NOT exist in the catalog at all.  Here the correct behaviour
--       is to tell the customer the product is unavailable and suggest alternatives —
--       NOT to say "a specialist will follow up", which creates a false expectation
--       and implies the product might exist.
--
-- This migration replaces the over-broad escalation line with two specific rules that
-- distinguish the two cases so the AI handles them correctly.
--
-- The block is platform-locked so the fix is force-synced to all tenants.

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  default_content = $c$
- When multiple products match the customer''s query (same category, ingredient, type, or product group), treat the question as being about the GROUP — not a single SKU.
- For attribute questions (flavors, sizes, colors, variants, brands, weights, packaging, ingredients, specs, usage differences): aggregate information across ALL matching products shown in the catalog context and any aggregated attribute summary.
- List every distinct attribute value found across the group and which product(s) have each value.
- Never answer using only one product when multiple relevant products exist unless the customer explicitly chose one specific product.
- When recommending from a group, you may still suggest 1-2 options — but attribute answers (e.g. available flavors) must cover the full matching set.
- If a matching product exists in the catalog but a specific attribute or technical detail is not available in the catalog data, say what is known and what is not — do NOT guess the missing detail; if critical information is genuinely absent from the catalog, note that you do not have that specific detail available.
- If the product the customer is asking about does not exist in our catalog at all, do NOT say a specialist will follow up — instead, clearly tell the customer that product is not available, then immediately suggest 1-2 relevant alternatives from the catalog if any exist.
$c$,
  updated_at = now()
WHERE key = 'guidelines.category_product_aggregation';

-- 2. Force-sync to ALL tenant blocks for this platform-locked key
--    (unconditional — no content-equality filter, same pattern as migration 052/053).
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key                = 'guidelines.category_product_aggregation'
  AND tpb.prompt_block_id  = pb.id
  AND tpb.content IS DISTINCT FROM pb.default_content;
