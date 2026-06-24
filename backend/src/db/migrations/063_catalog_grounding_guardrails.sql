-- Migration 063: Catalog grounding guardrails
--
-- Problem fixed:
--   The AI was recommending products that do not exist in the catalog when a
--   customer asked for "other options" in a category. Two prompt guidelines
--   allowed this gap:
--
--   1. guidelines.catalog_integrity said "never fabricate product DETAILS" but
--      did not explicitly prohibit naming a product that is not listed in the
--      catalog context — the LLM could name a non-existent product while
--      technically obeying the "don't fabricate details" rule.
--
--   2. guidelines.recommendations said "suggest only 1-2 products from the
--      catalog" but "the catalog" was ambiguous when the system prompt also said
--      "the full catalog has N more products" — the LLM interpreted this as
--      permission to name products from the hidden portion.
--
-- Fix:
--   Add an explicit, strongly-worded rule to guidelines.catalog_integrity:
--   the assistant may ONLY name products that appear in the Product catalog
--   section of the current system prompt. Any other product name is off-limits.
--
--   This change applies to the platform-locked block so it is automatically
--   propagated to all tenant copies via the forceSyncLockedBlocks mechanism.

UPDATE prompt_blocks
SET
  default_content = $block$
- If the customer asks about a product you don't have, say so honestly.
- When the requested product is unavailable or not an exact match, clearly say that exact product is not available, then immediately suggest 1-2 similar alternatives from the same category in the catalog (never more than two).
- For unavailable-product cases, keep the sequence: (1) unavailable acknowledgement, (2) relevant alternatives from same category, (3) short order-oriented follow-up question.
- Never fabricate product details, prices, or availability.
- CATALOG GROUNDING (critical): only name or recommend specific products that appear in the Product catalog section of this prompt. Never name, suggest, or reference a product by a specific name that is not listed there — not even if you believe the store might carry it. If the customer asks about more options and none are listed, say you have shown all available options and invite them to ask about something specific.
- For business location, physical address, pickup point, hours, or general "about the business" questions: use only the Business profile section when it is present above. If it does not contain the answer, do not invent one — offer to have a team member help.
- If a question is outside your scope, politely let the customer know a human agent can help.
$block$,
  updated_at = now()
WHERE key = 'guidelines.catalog_integrity';

-- Propagate the updated default to all tenant copies of this platform-locked block
-- so every store immediately benefits from the stricter guardrail.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE tpb.block_key = pb.key
  AND pb.key        = 'guidelines.catalog_integrity'
  AND pb.is_platform_locked = true;
