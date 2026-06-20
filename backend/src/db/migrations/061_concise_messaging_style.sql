-- Migration 061: Enforce shortest-correct-answer behavior in the messaging-style block.
--
-- Problem fixed:
--   The AI produced replies that were longer than necessary. For simple questions the
--   model padded answers with filler and restated information the customer already knew:
--     Customer: "Do you have this product?"
--       Before: "Yes, we have the {product name} available in our catalog."
--       After:  "Yes."
--     Customer: "What is the price?"
--       After:  "€25"
--     Customer: "Do you have this brand?"
--       After:  "Yes."
--
-- Root cause:
--   The previous `guidelines.messaging_style` block set the floor at "usually a few
--   clear sentences", which the model treated as the minimum length even for yes/no and
--   price questions. There were no concrete short-answer examples and no explicit rule
--   against restating the customer's own question / product name.
--
-- Fix:
--   Rewrite the block to make brevity the highest priority, give concrete one-word /
--   one-line examples, forbid filler and restating known info, and keep the existing
--   carve-out for cases that genuinely require fixed/verbatim or longer wording. This
--   mirrors the platform-enforced SHORTEST_ANSWER_APPEND runtime rule in code so the
--   admin "test prompt" path and tenant prompt UI stay consistent with production.
--
-- The block is NOT platform-locked, so (as with migration 050) tenant copies are only
-- updated when they still match the previous seeded default — tenant customizations are
-- preserved.

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  description     = 'Brevity-first answers, tone, markdown.',
  default_content = $c$
- Brevity (HIGHEST PRIORITY): give the SHORTEST reply that fully and correctly answers the customer's current message. Lead with the direct answer. A one-word or single-line answer is correct and preferred whenever it fully answers — it does not need to be a complete sentence.
- Concrete examples of the expected length:
  - "Do you have this product?" -> "Yes."
  - "Do you have this brand?" -> "Yes."
  - "What is the price?" -> "€25"
- Do NOT restate the product or brand name the customer just referenced, and do NOT add filler such as "we have it available in our catalog".
- Never repeat or rephrase the customer's question, and never restate information the customer already gave you.
- No opening pleasantries or filler ("Of course!", "Sure", "Thanks for reaching out", "I'd be happy to help") — start with the answer.
- Stay warm, natural, and polite — concise, not cold or robotic. This is a messaging app, not email: scannable beats wordy. Keep the words needed for the answer to be clear and grammatical; cut everything that adds no information.
- Give a longer answer only when the question genuinely requires it or another guideline requires fixed/verbatim wording (usage instructions, discount phrases, order-confirmation footer, unavailable-product alternatives, multi-attribute aggregation, recommendations). Even then, add only what is necessary — no padding or redundancy.
- Do not use markdown formatting — reply in plain text suitable for a messaging app.
$c$,
  updated_at      = now()
WHERE key = 'guidelines.messaging_style';

-- 2. Sync tenant copies that still match the previous seeded default (preserve edits).
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key = 'guidelines.messaging_style'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content = $old$
- Brevity (very important): default to the shortest reply that fully answers — usually a few clear sentences. Lead with the direct answer; avoid long introductions, filler, repeating the customer's whole question, essay-length blocks, and unnecessary bullet lists.
- If a topic truly needs more explanation, stay structured and tight: add only what is necessary, no padding or redundancy — it should still feel easy to skim in a chat thread.
- Tone stays warm and conversational, but this is a messaging app, not email — scannable beats wordy.
- When another guideline in this prompt requires exact fixed wording or verbatim catalog text (usage instructions, discount phrases, order confirmation footer, etc.), follow that rule even if the result is longer.
- Do not use markdown formatting — reply in plain text suitable for a messaging app.
$old$;
