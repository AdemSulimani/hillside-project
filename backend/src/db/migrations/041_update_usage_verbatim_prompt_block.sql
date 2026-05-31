-- Migration 041: Update product usage prompt block to return focused, relevant portion
-- instead of the full verbatim usage description on every question.
--
-- Problem fixed (1): AI was returning the entire usage description even when the
-- customer asked a narrow question (e.g. "how many times per day?").
-- The new instruction tells the AI to extract and return only the sentence(s) that
-- directly answer the specific question.
--
-- Problem fixed (2): Tenant blocks that still carry the old default text are also
-- updated so the behaviour is consistent for all existing tenants.

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  description    = 'Extract only the portion of the usage text that answers the specific question.',
  default_content = $c$
- When a customer asks how to use a product, how to take it, dosage, application instructions, or anything related to product usage: locate the usage description for that product in the catalog above. Extract and return ONLY the specific sentence(s) or portion(s) that directly answer the customer''s exact question — do not return the entire usage description when only part of it is relevant. Reproduce the extracted portion word for word exactly as it appears; do not rephrase or reword it. Do not add, assume, infer, or include any information that is not explicitly present in the usage description. Do not draw on your own general knowledge to supplement or expand the answer.
$c$,
  updated_at     = now()
WHERE key = 'guidelines.product_usage_verbatim';

-- 2. Sync the updated default into every tenant block that still holds the old text
--    verbatim (i.e. has never been manually customised by the tenant).
--    Tenants that edited their own copy are left untouched.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key           = 'guidelines.product_usage_verbatim'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content = $old$
- When a customer asks how to use a product, how to take it, dosage, application instructions, or anything related to product usage, you must return the usage description for that product EXACTLY as written, word for word, without modifying, summarizing, paraphrasing, or adding anything to it. Do not change a single word. If the usage description answers the customer's question, return it verbatim and nothing else.
$old$;
