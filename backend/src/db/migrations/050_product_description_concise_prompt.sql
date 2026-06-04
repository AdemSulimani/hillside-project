-- Migration 050: Keep product descriptions concise in customer-facing AI replies.
--
-- Problem: The model often pasted entire product descriptions during recommendations
-- because full description text was injected into the catalog context.
--
-- Fix: Strengthen platform guidelines (same pattern as migration 041 for usage text).

UPDATE prompt_blocks
SET
  description     = 'Concise product descriptions in recommendations and Q&A.',
  default_content = $c$
- NEVER paste or paraphrase the full product description to the customer. Catalog entries may include a brief summary and/or a longer internal reference — customer-facing text must stay short.
- For recommendations, comparisons, or product suggestions: suggest only 1-2 products from the catalog (never more than two). Per product, add at most 1-2 short lines with key benefits or selling points from the catalog — do not copy long description text.
- When the customer asks a specific question about a product (features, materials, benefits, ingredients, "tell me more", etc.): answer ONLY what they asked using relevant catalog facts; if a broader overview is needed, give a 1-2 line summary of the most important points — never the full description.
- For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add a follow-up question, invitation, "let me know" prompt, or any closing prompt — the only exception is the single allowed order-oriented follow-up question on the very first product turn (at most one short sentence).
- In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
- In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.
$c$,
  updated_at      = now()
WHERE key = 'guidelines.recommendations';

UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key = 'guidelines.recommendations'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content = $old$
- Exception — when the customer asks for recommendations, which product to choose/compare, or product suggestions for a specific situation or need: suggest only 1-2 products from the catalog (never more than two).
- For each of those products, add a very short description using only what appears in that product's catalog entry (one tight phrase or sentence per product; trim the catalog text if needed — do not invent details).
- For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add a follow-up question, invitation, "let me know" prompt, or any closing prompt — the only exception is the single allowed order-oriented follow-up question on the very first product turn (at most one short sentence).
- In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
- In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.
$old$;

INSERT INTO prompt_blocks (key, title, description, default_content, category, sort_order, is_platform_locked)
VALUES (
  'guidelines.product_description_responses',
  'Product description length',
  'Never send full catalog descriptions to customers.',
  $c$
- NEVER send the full product description text to the customer, even when a longer description appears in the catalog context above.
- For recommendations or general product talk: at most 1-2 short lines per product with key benefits or selling points from the catalog — do not copy long catalog text.
- When the customer asks about product details: read the catalog internally, then reply with ONLY the information that answers their question; if they need a broader overview, write a 1-2 line summary of the most important points — never paste the full description verbatim.
$c$,
  'guidelines',
  75,
  false
)
ON CONFLICT (key) DO UPDATE SET
  title           = EXCLUDED.title,
  description     = EXCLUDED.description,
  default_content = EXCLUDED.default_content,
  category        = EXCLUDED.category,
  sort_order      = EXCLUDED.sort_order,
  is_platform_locked = EXCLUDED.is_platform_locked,
  updated_at      = now();

INSERT INTO tenant_prompt_blocks (tenant_id, prompt_block_id, block_key, enabled, content, sort_order)
SELECT t.id, pb.id, pb.key, true, pb.default_content, pb.sort_order
FROM tenants t
CROSS JOIN prompt_blocks pb
WHERE pb.key = 'guidelines.product_description_responses'
  AND NOT EXISTS (
    SELECT 1
    FROM tenant_prompt_blocks tpb
    WHERE tpb.tenant_id = t.id
      AND tpb.block_key = pb.key
  );
