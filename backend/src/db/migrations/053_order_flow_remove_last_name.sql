-- Migration 053: Remove the "last name" requirement from the order flow prompt block.
--
-- Previously (migration 043) the AI was instructed to collect first name, last name,
-- phone number, and delivery address before sending the data-confirmation message.
-- The product requirement has changed: only first name, phone, and address are needed.
--
-- Changes made to the prompt block text:
--   - "ask ONLY for: (1) customer first name, (2) customer last name, (3) contact phone
--     number, and (4) full delivery address" → removes last name, renumbers the list
--   - "After you have collected the first name, last name, phone number, and delivery
--     address" → updated to remove last name
--   - "ALL required delivery details are present: customer first name, customer last name,
--     a contact phone number..." → updated
--
-- This migration uses an unconditional UPDATE (not a content-equality filter) so that
-- every tenant — including those who were missed by earlier migrations — receives the
-- updated instructions.

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  description     = 'Classifier closes, delivery fields, data confirmation, confirmations, post-purchase.',
  default_content = $c$
- If the message is detected as an end-of-conversation signal by the closing-intent classifier, respond with exactly one short polite closing sentence in the customer language.
- For classifier-detected closing replies, do not ask follow-up questions and do not introduce new topics.
- When collecting delivery details for an order, ask ONLY for: (1) customer first name, (2) contact phone number, and (3) full delivery address. Do not ask for last name, ID number, birthday, email, or any other personal data unless the business explicitly requires it elsewhere.
- If the customer''s message already contains a clear order intent (e.g., "I want to order", "Dua ta porosis", affirming a product), do NOT ask an order-closing question such as "A doni ta porosisni?" or "Would you like to order?" — proceed directly to asking for any missing delivery details.
- After you have collected the first name, phone number, and delivery address, do NOT confirm the order yet. Instead send this exact data-verification message to the customer: {{DATA_CONFIRMATION_SENTENCE}}. Only after the customer confirms that their details are correct should you treat the order as confirmed.
{{ORDER_CONFIRMATION_CLOSING_RULE}}
{{DELIVERY_ETA_NOTE}}
- For ambiguous short customer replies (e.g., "po", "ok", "yes", "po ju lutem"), rely on conversation context and classifier signals to decide intent. Do not classify based only on keywords. If classifier/context indicates order affirmation, continue order flow; escalate only when classifier/context indicates a real post-purchase issue.
- Draft/confirm order behavior must be triggered only when classifier + conversation context indicate explicit order affirmation. Product inquiries alone (price, stock, details, comparison, availability) are not order confirmation.
- If the assistant has already asked to proceed with an order (or requested delivery details), and the customer then provides ALL required details (first name, phone number, and full delivery address), send the data-verification message above before confirming the order.
- Never treat an order as complete/ready for creation unless ALL required delivery details are present: customer first name, a contact phone number, and a full delivery/shipping address. If any detail is missing, ask specifically for the missing detail and do not confirm order placement yet.
{{POST_PURCHASE_ESCALATION_RULE}}
$c$,
  updated_at = now()
WHERE key = 'guidelines.order_flow_and_escalation';

-- 2. Force-sync to ALL tenant blocks (unconditional — no content-equality filter).
--    This ensures tenants missed by earlier exact-string migrations receive the update.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key            = 'guidelines.order_flow_and_escalation'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content IS DISTINCT FROM pb.default_content;
