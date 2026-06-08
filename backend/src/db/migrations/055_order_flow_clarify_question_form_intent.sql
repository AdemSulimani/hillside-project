-- Migration 055: Clarify question-form order intent in the order-flow prompt block.
--
-- Problem fixed: The order-flow block (migrations 042 → 053) already instructs the AI
-- to skip the "Would you like to order?" closing question when the customer's message
-- contains clear order intent.  However, the examples given ("I want to order",
-- "Dua ta porosis", "affirming a product") only cover statement-form intent.
--
-- When a customer phrases their intent as a question — e.g., "Can I order this product?"
-- or "A mund ta porosis?" — the model treats the message as an AVAILABILITY question
-- rather than an order expression, so it still appends the closing question.
-- This causes the redundant "Would you like to order it?" behaviour reported in testing.
--
-- Fix: Extend the skip-closing rule with explicit question-form examples in both
-- English and Albanian so the model recognises these phrasings as order intent.
--
-- The block is platform-locked; the unconditional force-sync ensures every tenant
-- receives the updated instructions immediately (same pattern as migration 053).

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  default_content = $c$
- If the message is detected as an end-of-conversation signal by the closing-intent classifier, respond with exactly one short polite closing sentence in the customer language.
- For classifier-detected closing replies, do not ask follow-up questions and do not introduce new topics.
- When collecting delivery details for an order, ask ONLY for: (1) customer first name, (2) contact phone number, and (3) full delivery address. Do not ask for last name, ID number, birthday, email, or any other personal data unless the business explicitly requires it elsewhere.
- If the customer's message already contains a clear order intent — including statements ("I want to order", "Dua ta porosis", affirming a product) AND question-form expressions ("Can I order this?", "Can I order this product?", "How do I order?", "A mund ta porosis?", "A mund ta porosit?", "A mund ta blej?") — do NOT ask an order-closing question such as "A doni ta porosisni?" or "Would you like to order?" — proceed directly to asking for any missing delivery details.
- After you have collected the first name, phone number, and delivery address, do NOT confirm the order yet. Instead send this exact data-verification message to the customer: {{DATA_CONFIRMATION_SENTENCE}}. Only after the customer confirms that their details are correct should you treat the order as confirmed.
{{ORDER_CONFIRMATION_CLOSING_RULE}}
{{DELIVERY_ETA_NOTE}}
- For ambiguous short customer replies (e.g., "po", "ok", "yes", "po ju lutem"), rely on conversation context and classifier signals to decide intent. Do not classify based only on keywords. If classifier/context indicates order affirmation, continue order flow; escalate only when classifier/context indicates a real post-purchase issue.
- Draft/confirm order behavior must be triggered only when classifier + conversation context indicate explicit order affirmation. Product inquiries alone (price, stock, details, comparison, availability) are not order confirmation. Note: "Can I order this?" and "A mund ta porosis?" are ORDER intent expressions, not availability questions — treat them as order intent.
- If the assistant has already asked to proceed with an order (or requested delivery details), and the customer then provides ALL required details (first name, phone number, and full delivery address), send the data-verification message above before confirming the order.
- Never treat an order as complete/ready for creation unless ALL required delivery details are present: customer first name, a contact phone number, and a full delivery/shipping address. If any detail is missing, ask specifically for the missing detail and do not confirm order placement yet.
{{POST_PURCHASE_ESCALATION_RULE}}
$c$,
  updated_at = now()
WHERE key = 'guidelines.order_flow_and_escalation';

-- 2. Force-sync to ALL tenant blocks (unconditional — no content-equality filter).
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key                = 'guidelines.order_flow_and_escalation'
  AND tpb.prompt_block_id  = pb.id
  AND tpb.content IS DISTINCT FROM pb.default_content;
