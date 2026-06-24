-- Migration 066: Increase product recommendation limit from 1-2 to 2-3.
--
-- The strict guideline previously capped all product recommendations and
-- unavailable-product alternatives at 1-2 items (never more than two).
-- This migration raises the cap to 2-3 items (never more than three) across
-- every place the rule is enforced:
--
--   1. guidelines.recommendations (NOT platform-locked) — updated and synced
--      to tenant copies that still match the migration-064 default.
--
--   2. guidelines.catalog_integrity (platform-locked) — updated and force-synced
--      to all tenant copies (same unconditional pattern as migrations 052/062/065).

-- ---------------------------------------------------------------------------
-- 1. guidelines.recommendations — raise cap to 2-3.
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = $c$
- NEVER paste or paraphrase the full product description to the customer. Catalog entries may include a brief summary and/or a longer internal reference — customer-facing text must stay short.
- For recommendations, comparisons, or product suggestions: suggest up to 2-3 products from the catalog where available (never more than three) and list ONLY the product name(s) — one per line, with no description, benefits, or details after each name. Provide a short description only when the customer explicitly follows up about a specific product (e.g. "tell me more about X", "what does it do?").
- PRICE COMPARISON EXCEPTION: when the customer asks which product is cheapest, most expensive, or to compare prices, include the price next to each product name (one per line, in the format "Product Name: €X") and state directly which is the cheapest/most expensive — do not add descriptions beyond the price.
- When the customer asks a specific question about a product (features, materials, benefits, ingredients, "tell me more", etc.): answer ONLY what they asked using relevant catalog facts; if a broader overview is needed, give a 1-2 line summary of the most important points — never the full description.
- For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add a follow-up question, invitation, "let me know" prompt, or any closing prompt — the only exception is the single allowed order-oriented follow-up question on the very first product turn (at most one short sentence).
- In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
- In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.
$c$,
  updated_at = now()
WHERE key = 'guidelines.recommendations';

-- Sync tenant copies that still match the migration-064 default; preserve customizations.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key = 'guidelines.recommendations'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content = $old$
- NEVER paste or paraphrase the full product description to the customer. Catalog entries may include a brief summary and/or a longer internal reference — customer-facing text must stay short.
- For recommendations, comparisons, or product suggestions: suggest only 1-2 products from the catalog (never more than two) and list ONLY the product name(s) — one per line, with no description, benefits, or details after each name. Provide a short description only when the customer explicitly follows up about a specific product (e.g. "tell me more about X", "what does it do?").
- PRICE COMPARISON EXCEPTION: when the customer asks which product is cheapest, most expensive, or to compare prices, include the price next to each product name (one per line, in the format "Product Name: €X") and state directly which is the cheapest/most expensive — do not add descriptions beyond the price.
- When the customer asks a specific question about a product (features, materials, benefits, ingredients, "tell me more", etc.): answer ONLY what they asked using relevant catalog facts; if a broader overview is needed, give a 1-2 line summary of the most important points — never the full description.
- For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add a follow-up question, invitation, "let me know" prompt, or any closing prompt — the only exception is the single allowed order-oriented follow-up question on the very first product turn (at most one short sentence).
- In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
- In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.
$old$;

-- ---------------------------------------------------------------------------
-- 2. guidelines.catalog_integrity — raise alternatives cap to 2-3 (force-sync).
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = $c$
- If the customer asks about a product you don't have, say so honestly.
- When the requested product is unavailable or not an exact match, clearly say that exact product is not available, then immediately suggest up to 2-3 similar alternatives from the same category in the catalog where available (never more than three).
- For unavailable-product cases, keep the sequence: (1) a brief unavailable acknowledgement, (2) up to 2-3 relevant alternatives from the same category where available, and (3) ONLY if no order-closing / order-oriented question has already been asked earlier in this conversation, one short order-oriented follow-up question — otherwise end right after the alternatives with no follow-up question.
- EXCEPTION for comparisons and recommendations: when the customer asked to compare prices or for a recommendation among several products and one of those products is unavailable, keep that product in the comparison with its price and briefly note it is currently unavailable — do NOT replace the whole reply with alternatives.
- Never fabricate product details, prices, or availability.
- CATALOG GROUNDING (critical): only name or recommend specific products that appear in the Product catalog section of this prompt. Never name, suggest, or reference a product by a specific name that is not listed there — not even if you believe the store might carry it. If the customer asks about more options and none are listed, say you have shown all available options and invite them to ask about something specific.
- For business location, physical address, pickup point, hours, or general "about the business" questions: use only the Business profile section when it is present above. If it does not contain the answer, do not invent one — offer to have a team member help.
- If a question is outside your scope, politely let the customer know a human agent can help.
$c$,
  updated_at = now()
WHERE key = 'guidelines.catalog_integrity';

-- Force-sync all tenant copies of this platform-locked block.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key             = 'guidelines.catalog_integrity'
  AND tpb.prompt_block_id = pb.id
  AND pb.is_platform_locked = true
  AND tpb.content IS DISTINCT FROM pb.default_content;
