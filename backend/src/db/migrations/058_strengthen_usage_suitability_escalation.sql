-- Migration 058: Strengthen the product usage prompt block to prevent the AI from
-- generating speculative health/medical advice for suitability questions.
--
-- Problem fixed:
--   When a customer asks a suitability or safety question such as:
--     "I do not work out. Is there any problem if I use this?"
--     "Can I use this product without exercising?"
--     "Is this suitable for me?"
--   ...the AI was generating general health recommendations from its training knowledge
--   (e.g. "It is important to consult a health professional or dietitian before using
--   weight gain supplements...") instead of either using catalog data or escalating.
--
-- Root cause:
--   The previous instruction focused on HOW to return usage-description content when
--   it exists, but gave no guidance for the case where the usage description does NOT
--   specifically address the customer's personal circumstances or suitability concern.
--   Faced with silence in the catalog, the model fell back to training knowledge.
--
-- Fix:
--   Add an explicit rule: when the usage description does not specifically and directly
--   address the customer's suitability / personal-circumstance question, the AI must NOT
--   generate an answer from general knowledge, medical training, or assumptions.
--   It must simply state that the specific information is not available.  The escalation
--   pipeline (classifyUsageQuestionIntent + isUsageQuestionUnanswered + the speculative-
--   advice safety-net guard in processAIReply.ts) then handles the escalation and sends
--   the customer the correct holding message.
--
-- The block is platform-locked so the fix is force-synced to all tenants.

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  default_content = $c$
- When a customer asks how to use a product, how to take it, dosage, application instructions, or anything related to product usage: locate the usage description for that product in the catalog above. Extract and return ONLY the specific sentence(s) or portion(s) that directly answer the customer''s exact question — do not return the entire usage description when only part of it is relevant. Reproduce the extracted portion word for word exactly as it appears; do not rephrase or reword it. Do not add, assume, infer, or include any information that is not explicitly present in the usage description. Do not draw on your own general knowledge to supplement or expand the answer.
- If the customer''s question is about personal suitability, safety, or compatibility in specific circumstances (e.g. "I don''t work out, can I use this?", "Is this suitable for me?", "I''m pregnant, is this ok?", "Can I use this without exercising?", "Any problem if I don''t exercise?") and the usage description does NOT explicitly address that specific circumstance: do NOT generate health advice, medical recommendations, or guidance from your general training knowledge. Do not speculate. Simply say you do not have that specific information available. A specialist will provide accurate guidance.
$c$,
  updated_at = now()
WHERE key = 'guidelines.product_usage_verbatim';

-- 2. Force-sync to ALL tenant blocks for this platform-locked key.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key               = 'guidelines.product_usage_verbatim'
  AND tpb.prompt_block_id  = pb.id
  AND tpb.content IS DISTINCT FROM pb.default_content;
