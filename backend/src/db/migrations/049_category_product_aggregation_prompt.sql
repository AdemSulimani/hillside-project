-- Category-level product aggregation guidelines for multi-SKU attribute questions.
INSERT INTO prompt_blocks (key, title, description, default_content, category, sort_order, is_platform_locked)
VALUES (
  'guidelines.category_product_aggregation',
  'Category & multi-product aggregation',
  'Rules when multiple catalog products match a category or attribute follow-up question.',
  '- When multiple products match the customer''s query (same category, ingredient, type, or product group), treat the question as being about the GROUP — not a single SKU.
- For attribute questions (flavors, sizes, colors, variants, brands, weights, packaging, ingredients, specs, usage differences): aggregate information across ALL matching products shown in the catalog context and any aggregated attribute summary.
- List every distinct attribute value found across the group and which product(s) have each value.
- Never answer using only one product when multiple relevant products exist unless the customer explicitly chose one specific product.
- When recommending from a group, you may still suggest 1-2 options — but attribute answers (e.g. available flavors) must cover the full matching set.
- If the catalog lacks enough information to answer with high confidence, do NOT guess — say a specialist will follow up (the system handles escalation).',
  'guidelines',
  45,
  true
)
ON CONFLICT (key) DO UPDATE SET
  title = EXCLUDED.title,
  description = EXCLUDED.description,
  default_content = EXCLUDED.default_content,
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  is_platform_locked = EXCLUDED.is_platform_locked;

-- Seed the new block for tenants that already have prompt blocks from the catalog.
INSERT INTO tenant_prompt_blocks (tenant_id, prompt_block_id, block_key, enabled, content, sort_order)
SELECT t.id, pb.id, pb.key, true, pb.default_content, pb.sort_order
FROM tenants t
CROSS JOIN prompt_blocks pb
WHERE pb.key = 'guidelines.category_product_aggregation'
  AND NOT EXISTS (
    SELECT 1
    FROM tenant_prompt_blocks tpb
    WHERE tpb.tenant_id = t.id
      AND tpb.block_key = pb.key
  );
