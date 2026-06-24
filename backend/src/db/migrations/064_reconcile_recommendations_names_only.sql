-- Migration 064: Reconcile guidelines.recommendations with the runtime concise-description rule.
--
-- Problem fixed:
--   The platform-enforced runtime append (PRODUCT_DESCRIPTION_CONCISE_APPEND in
--   productDescriptionPromptService.ts) instructs the model, for recommendations /
--   comparisons / suggestions, to list ONLY the product name(s) and to give a
--   description ONLY when the customer explicitly follows up. That append is added
--   last and self-declares highest priority.
--
--   The seeded guidelines.recommendations block (migration 050) still said the
--   opposite: "Per product, add at most 1-2 short lines with key benefits". The
--   system prompt therefore contained two directly contradictory instructions for
--   the same turn type. The model resolves that conflict inconsistently, which shows
--   up as recommendations that sometimes include descriptions and sometimes do not.
--
-- Fix:
--   Align the guideline block with the authoritative runtime append (names-only for
--   recommendations, plus the same price-comparison exception). This does NOT change
--   effective behavior — the highest-priority append already enforces names-only at
--   runtime — it only removes the contradictory text so the prompt is internally
--   consistent and the model behaves the same way every time.
--
-- The block is NOT platform-locked, so (as with migrations 050 / 061) tenant copies
-- are only updated when they still match the previous seeded default — tenant
-- customizations are preserved.

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  default_content = $c$
- NEVER paste or paraphrase the full product description to the customer. Catalog entries may include a brief summary and/or a longer internal reference — customer-facing text must stay short.
- For recommendations, comparisons, or product suggestions: suggest only 1-2 products from the catalog (never more than two) and list ONLY the product name(s) — one per line, with no description, benefits, or details after each name. Provide a short description only when the customer explicitly follows up about a specific product (e.g. "tell me more about X", "what does it do?").
- PRICE COMPARISON EXCEPTION: when the customer asks which product is cheapest, most expensive, or to compare prices, include the price next to each product name (one per line, in the format "Product Name: €X") and state directly which is the cheapest/most expensive — do not add descriptions beyond the price.
- When the customer asks a specific question about a product (features, materials, benefits, ingredients, "tell me more", etc.): answer ONLY what they asked using relevant catalog facts; if a broader overview is needed, give a 1-2 line summary of the most important points — never the full description.
- For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add a follow-up question, invitation, "let me know" prompt, or any closing prompt — the only exception is the single allowed order-oriented follow-up question on the very first product turn (at most one short sentence).
- In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
- In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.
$c$,
  updated_at = now()
WHERE key = 'guidelines.recommendations';

-- 2. Sync tenant copies that still match the previous seeded default (migration 050),
--    preserving any tenant edits.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key = 'guidelines.recommendations'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content = $old$
- NEVER paste or paraphrase the full product description to the customer. Catalog entries may include a brief summary and/or a longer internal reference — customer-facing text must stay short.
- For recommendations, comparisons, or product suggestions: suggest only 1-2 products from the catalog (never more than two). Per product, add at most 1-2 short lines with key benefits or selling points from the catalog — do not copy long description text.
- When the customer asks a specific question about a product (features, materials, benefits, ingredients, "tell me more", etc.): answer ONLY what they asked using relevant catalog facts; if a broader overview is needed, give a 1-2 line summary of the most important points — never the full description.
- For recommendation, explanation, or comparison replies: end with the recommendation itself; do NOT add a follow-up question, invitation, "let me know" prompt, or any closing prompt — the only exception is the single allowed order-oriented follow-up question on the very first product turn (at most one short sentence).
- In these recommendation cases, explicitly mention the relevant product names clearly (still without quotation marks).
- In customer-facing text, refer to items by product name only; do not include the brand name unless the customer explicitly asks for brand details.
$old$;
