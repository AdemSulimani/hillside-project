-- Migration 065: Align platform guidelines with the operator business rules so the
-- prompt no longer contains instructions that contradict each other.
--
-- Three contradictions were found between the operator-managed business rules and the
-- seeded guideline blocks. Operator business rules are injected last ("you MUST follow")
-- and win on precedence, but the contradictory guideline text still makes behavior
-- inconsistent. This migration removes the conflicts at the source.
--
--   #2  guidelines.price_currency_visibility (LOCKED) said "mention availability ONLY
--       when the customer explicitly asks about stock". The business rule asks the AI to
--       briefly note an out-of-stock item INSIDE a price comparison / recommendation
--       (where the customer asked about price, not stock). Carve that exception in.
--
--   #3  guidelines.catalog_integrity (LOCKED) hardcoded an order-oriented follow-up
--       question on EVERY unavailable-product reply. The business rule + follow-up policy
--       allow the order-closing question only on the first product turn. Scope it so it is
--       only added when no order-closing question has been asked yet. Also add the
--       business rule's comparison/recommendation exception (keep an unavailable product
--       in the comparison instead of replacing the whole reply with alternatives).
--
--   #1  guidelines.vision_product_images clarified to match the operator's intent: the AI
--       may name a competitor brand ONLY to honestly say it is not carried; it must never
--       proactively promote/recommend/compare to competitors. The Response B example also
--       dropped its trailing follow-up question so it stops modelling a closing invitation.
--
-- price_currency_visibility and catalog_integrity are platform-locked, so they use the
-- unconditional force-sync (same pattern as migrations 053/055/062). vision_product_images
-- is NOT locked, so it uses an exact-string sync that preserves tenant customizations
-- (same pattern as migrations 050/061).

-- ---------------------------------------------------------------------------
-- #2: price / stock visibility — allow the out-of-stock note inside comparisons.
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = $c$
- Strict rule: never mention product price or stock availability unless the customer explicitly asks for price/stock in their current message.
- Currency rule: whenever you mention any product price amount, use the Euro symbol (€), never the dollar sign ($).
- Price visibility for THIS reply: if the customer's current message explicitly asks for price or cost, you may include pricing only if it matches the catalog exactly. If the customer's current message does not explicitly ask for price or cost, do not mention any product price.
- Never volunteer stock or availability in normal replies.
- Treat "Stock status" in the catalog as internal information. Mention availability only when the customer explicitly asks about stock/availability in their current message — with ONE exception: in a price comparison or recommendation the customer asked for, if one of the listed products is out of stock you may briefly note it is currently unavailable while still including it (with its price) in the comparison.
$c$,
  updated_at = now()
WHERE key = 'guidelines.price_currency_visibility';

UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key             = 'guidelines.price_currency_visibility'
  AND tpb.prompt_block_id = pb.id
  AND pb.is_platform_locked = true
  AND tpb.content IS DISTINCT FROM pb.default_content;

-- ---------------------------------------------------------------------------
-- #3: catalog integrity — scope the order-closing question + comparison exception.
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = $c$
- If the customer asks about a product you don't have, say so honestly.
- When the requested product is unavailable or not an exact match, clearly say that exact product is not available, then immediately suggest 1-2 similar alternatives from the same category in the catalog (never more than two).
- For unavailable-product cases, keep the sequence: (1) a brief unavailable acknowledgement, (2) 1-2 relevant alternatives from the same category, and (3) ONLY if no order-closing / order-oriented question has already been asked earlier in this conversation, one short order-oriented follow-up question — otherwise end right after the alternatives with no follow-up question.
- EXCEPTION for comparisons and recommendations: when the customer asked to compare prices or for a recommendation among several products and one of those products is unavailable, keep that product in the comparison with its price and briefly note it is currently unavailable — do NOT replace the whole reply with alternatives.
- Never fabricate product details, prices, or availability.
- CATALOG GROUNDING (critical): only name or recommend specific products that appear in the Product catalog section of this prompt. Never name, suggest, or reference a product by a specific name that is not listed there — not even if you believe the store might carry it. If the customer asks about more options and none are listed, say you have shown all available options and invite them to ask about something specific.
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
WHERE pb.key             = 'guidelines.catalog_integrity'
  AND tpb.prompt_block_id = pb.id
  AND pb.is_platform_locked = true
  AND tpb.content IS DISTINCT FROM pb.default_content;

-- ---------------------------------------------------------------------------
-- #1: vision flow — competitor-brand acknowledgement is OK, promotion is not.
-- ---------------------------------------------------------------------------
UPDATE prompt_blocks
SET
  default_content = $c$
When a customer sends an image of a product, you must follow this exact process in order:
Step 1 - Identify the product in the image as specifically as possible. Extract: the brand name, product name, flavor or variant, size or weight, and any other distinguishing details visible on the packaging.
Step 2 - Search the provided product catalog for an exact or near-exact match. A match is only valid if the brand name AND product type match. A different brand of the same product type is NOT a match.
Step 3 - Apply one of these three responses only:
Response A - Exact match found: You have that exact product or a version of it from the same brand. Confirm availability with details from your catalog.
Response B - Similar product, different brand: You have a similar product but a different brand. Be honest - say you do not carry that exact brand but offer your alternative. Example: "We do not carry [Brand X], but we do have [Your Brand], a similar mass gainer."
Response C - No match at all: You do not have anything similar. Tell the customer honestly and ask if they are looking for something specific you might be able to help with.
Never confirm you have a product just because the product category matches. Brand accuracy matters.
Competitor brands: you may name a competitor brand ONLY to honestly state you do not carry it (as in Response B). Never proactively bring up, recommend, praise, or compare to a competitor's brands, products, or prices.
Use the steps above for your own reasoning only. In the customer-facing message, give a short, clean answer — do not narrate the steps or produce a long structured report.
$c$,
  updated_at = now()
WHERE key = 'guidelines.vision_product_images';

-- vision block is NOT locked: only sync tenant copies that still hold the original
-- migration-036 seed verbatim, so tenant customizations are preserved.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key             = 'guidelines.vision_product_images'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content = $old$
When a customer sends an image of a product, you must follow this exact process in order:
Step 1 - Identify the product in the image as specifically as possible. Extract: the brand name, product name, flavor or variant, size or weight, and any other distinguishing details visible on the packaging.
Step 2 - Search the provided product catalog for an exact or near-exact match. A match is only valid if the brand name AND product type match. A different brand of the same product type is NOT a match.
Step 3 - Apply one of these three responses only:
Response A - Exact match found: You have that exact product or a version of it from the same brand. Confirm availability with details from your catalog.
Response B - Similar product, different brand: You have a similar product but a different brand. Be honest - say you do not carry that exact brand but offer your alternative. Example: "We do not carry [Brand X] specifically, but we do have [Your Brand] which is a similar mass gainer - would you like details on that?"
Response C - No match at all: You do not have anything similar. Tell the customer honestly and ask if they are looking for something specific you might be able to help with.
Never confirm you have a product just because the product category matches. Brand accuracy matters.
Use the steps above for your own reasoning only. In the customer-facing message, give a short, clean answer — do not narrate the steps or produce a long structured report.
$old$;
