-- Migration 062: Make the "longer answer" edge cases more compact without losing meaning.
--
-- Follow-up to migration 061 (shortest-correct-answer). The edge cases that are allowed
-- to be longer (unavailable-product handling and multi-product/attribute aggregation)
-- still tended to include preamble, restate the customer's question, repeat the product
-- name, or add a closing summary. This migration trims those repeated/unnecessary parts
-- while preserving the required content (honest unavailability + alternatives, and the
-- full set of distinct attribute values for group questions).
--
-- Both blocks are platform-locked, so the change is force-synced to all tenants
-- (same pattern as migrations 054 / 058).

-- 1a. Unavailable-product handling: keep the reply to 2-3 short sentences, no preamble,
--     no restating the question, one short line per alternative, no closing summary.
UPDATE prompt_blocks
SET
  default_content = $c$
- If the customer asks about a product you don't have, say so honestly.
- When the requested product is unavailable or not an exact match, clearly say that exact product is not available, then immediately suggest 1-2 similar alternatives from the same category in the catalog (never more than two).
- For unavailable-product cases, keep the whole reply to 2-3 short sentences: (1) a brief "not available" acknowledgement with no preamble and without restating the question, (2) 1-2 alternatives with at most one short line each, (3) one short order-oriented follow-up question. Do not repeat the unavailable product name more than once and do not add a closing summary.
- Never fabricate product details, prices, or availability.
- For business location, physical address, pickup point, hours, or general "about the business" questions: use only the Business profile section when it is present above. If it does not contain the answer, do not invent one — offer to have a team member help.
- If a question is outside your scope, politely let the customer know a human agent can help.
$c$,
  updated_at = now()
WHERE key = 'guidelines.catalog_integrity';

UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key              = 'guidelines.catalog_integrity'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content IS DISTINCT FROM pb.default_content;

-- 1b. Multi-product / attribute aggregation: still list every distinct value, but compactly
--     (no intro line, no restating the question, no closing summary, group shared values).
UPDATE prompt_blocks
SET
  default_content = $c$
- When multiple products match the customer's query (same category, ingredient, type, or product group), treat the question as being about the GROUP — not a single SKU.
- For attribute questions (flavors, sizes, colors, variants, brands, weights, packaging, ingredients, specs, usage differences): aggregate information across ALL matching products shown in the catalog context and any aggregated attribute summary.
- List every distinct attribute value found across the group and which product(s) have each value.
- Keep it compact: list the values directly with no intro line, no restating the question, and no closing summary; group products that share a value instead of repeating it.
- Never answer using only one product when multiple relevant products exist unless the customer explicitly chose one specific product.
- When recommending from a group, you may still suggest 1-2 options — but attribute answers (e.g. available flavors) must cover the full matching set.
- If a matching product exists in the catalog but a specific attribute or technical detail is not available in the catalog data, say what is known and what is not — do NOT guess the missing detail; if critical information is genuinely absent from the catalog, note that you do not have that specific detail available.
- If the product the customer is asking about does not exist in our catalog at all, do NOT say a specialist will follow up — instead, clearly tell the customer that product is not available, then immediately suggest 1-2 relevant alternatives from the catalog if any exist.
$c$,
  updated_at = now()
WHERE key = 'guidelines.category_product_aggregation';

UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key              = 'guidelines.category_product_aggregation'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content IS DISTINCT FROM pb.default_content;
