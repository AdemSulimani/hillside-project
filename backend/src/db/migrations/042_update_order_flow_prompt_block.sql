-- Migration 042: Add "skip closing question when intent is clear" and "data-confirmation
-- step before order registration" rules to the order-flow prompt block.
--
-- Problem fixed (1): AI was asking "A doni ta porosisni?" / "Would you like to order?"
-- even when the customer's message already contained a clear order intent. The new rule
-- tells the AI to skip that question and go straight to collecting delivery details.
--
-- Problem fixed (2): The system was registering orders immediately after the customer
-- provided phone + address. The new rule adds a mandatory data-verification step:
-- the AI must first ask the customer to confirm that their details are correct, and
-- only register the order after the customer's confirmation.

-- 1. Update the global catalog default.
UPDATE prompt_blocks
SET
  description     = 'Classifier closes, delivery fields, data confirmation, confirmations, post-purchase.',
  default_content = $c$
- If the message is detected as an end-of-conversation signal by the closing-intent classifier, respond with exactly one short polite closing sentence in the customer language.
- For classifier-detected closing replies, do not ask follow-up questions and do not introduce new topics.
- When collecting delivery details for an order, ask ONLY for: (1) contact phone number and (2) full delivery address. Do not ask for name, surname, ID number, birthday, or any other personal data.
- If the customer''s message already contains a clear order intent (e.g., "I want to order", "Dua ta porosis", affirming a product), do NOT ask an order-closing question such as "A doni ta porosisni?" or "Would you like to order?" — proceed directly to asking for any missing delivery details.
- After you have collected BOTH the phone number and the delivery address, do NOT confirm the order yet. Instead send this exact data-verification message to the customer: {{DATA_CONFIRMATION_SENTENCE}}. Only after the customer confirms that their details are correct should you treat the order as confirmed.
{{ORDER_CONFIRMATION_CLOSING_RULE}}
{{DELIVERY_ETA_NOTE}}
- For ambiguous short customer replies (e.g., "po", "ok", "yes", "po ju lutem"), rely on conversation context and classifier signals to decide intent. Do not classify based only on keywords. If classifier/context indicates order affirmation, continue order flow; escalate only when classifier/context indicates a real post-purchase issue.
- Draft/confirm order behavior must be triggered only when classifier + conversation context indicate explicit order affirmation. Product inquiries alone (price, stock, details, comparison, availability) are not order confirmation.
- If the assistant has already asked to proceed with an order (or requested delivery details), and the customer then provides BOTH required details (phone number and full delivery address), send the data-verification message above before confirming the order.
- Never treat an order as complete/ready for creation unless BOTH required delivery details are present: a contact phone number and a full delivery/shipping address. If either detail is missing, ask specifically for the missing detail and do not confirm order placement yet.
{{POST_PURCHASE_ESCALATION_RULE}}
$c$,
  updated_at = now()
WHERE key = 'guidelines.order_flow_and_escalation';

-- 2. Sync the updated default into every tenant block that still holds the old text
--    verbatim (i.e. has never been manually customised by the tenant).
--    Tenants that edited their own copy are left untouched.
UPDATE tenant_prompt_blocks tpb
SET
  content    = pb.default_content,
  updated_at = now()
FROM prompt_blocks pb
WHERE pb.key            = 'guidelines.order_flow_and_escalation'
  AND tpb.prompt_block_id = pb.id
  AND tpb.content = $old$
- If the message is detected as an end-of-conversation signal by the closing-intent classifier, respond with exactly one short polite closing sentence in the customer language.
- For classifier-detected closing replies, do not ask follow-up questions and do not introduce new topics.
- When collecting delivery details for an order, ask ONLY for: (1) contact phone number and (2) full delivery address. Do not ask for name, surname, ID number, birthday, or any other personal data.
{{ORDER_CONFIRMATION_CLOSING_RULE}}
{{DELIVERY_ETA_NOTE}}
- For ambiguous short customer replies (e.g., "po", "ok", "yes", "po ju lutem"), rely on conversation context and classifier signals to decide intent. Do not classify based only on keywords. If classifier/context indicates order affirmation, continue order flow; escalate only when classifier/context indicates a real post-purchase issue.
- Draft/confirm order behavior must be triggered only when classifier + conversation context indicate explicit order affirmation. Product inquiries alone (price, stock, details, comparison, availability) are not order confirmation.
- If the assistant has already asked to proceed with an order (or requested delivery details), and the customer then provides BOTH required details (phone number and full delivery address), treat that as valid order-confirmation context even without an explicit "yes" in the latest message.
- Never treat an order as complete/ready for creation unless BOTH required delivery details are present: a contact phone number and a full delivery/shipping address. If either detail is missing, ask specifically for the missing detail and do not confirm order placement yet.
{{POST_PURCHASE_ESCALATION_RULE}}
$old$;
