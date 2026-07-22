import type { Message } from '../db/models/message';
import { openai, OPENAI_INTENT_MODEL } from './openaiClient';
import { withModelRole } from './openaiCallTracker';
import { logSafeStructured } from '../utils/redact';
import { logger } from '../utils/logger';
import { buildJsonSchema, parseStructuredCompletion, z } from './structuredClassifier';
import { EMPTY_INTENT_RESULT, mapIntentPayload, type IntentResult } from './intentPayload';

// Re-export so existing importers keep a single, stable entry point even though the pure
// payload-mapping logic now lives in the openaiClient-free `intentPayload` module (testability).
export { mapIntentPayload } from './intentPayload';
export type { IntentOrderItem, IntentResult } from './intentPayload';

/**
 * P2-2 (Slice A): when ON, the purchase-intent detector uses a strict `json_schema`
 * `response_format` with a Zod-validated payload (the shared structured-output contract) instead
 * of free-form `json_object` + a fail-open `JSON.parse`. A malformed/truncated structured output
 * then throws a retryable `StructuredContractError` rather than silently degrading to an all-zero
 * intent — the RC-22/I8 fail direction. Defaults OFF: the legacy fail-open path is preserved.
 */
const INTENT_STRUCTURED_CONTRACT =
  (process.env.INTENT_STRUCTURED_CONTRACT ?? 'false').trim().toLowerCase() === 'true';

/** Hand-authored strict schema for the purchase-intent completion (mirrors FACTS_USED_JSON_SCHEMA). */
const INTENT_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent_score',
    'product_name',
    'quantity',
    'items',
    'delivery_address',
    'customer_first_name',
    'is_ready_to_order',
    'reasoning',
  ],
  properties: {
    // Range deliberately NOT declared on the wire: `strict: true` schema validators have
    // historically rejected `minimum`/`maximum` as unsupported keywords, and a schema the API
    // refuses would 400 EVERY intent call at flag-on. The declared-range half of the contract is
    // enforced in the Zod layer below instead — same fail direction (retryable contract error).
    intent_score: { type: 'number' },
    // Scalar product_name/quantity are kept as the PRIMARY-product slot (backward compat with every
    // existing scalar reader); `items` carries the full multi-product basket (migration 088).
    product_name: { type: ['string', 'null'] },
    quantity: { type: ['integer', 'null'] },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['product_name', 'quantity'],
        properties: {
          product_name: { type: ['string', 'null'] },
          quantity: { type: ['integer', 'null'] },
        },
      },
    },
    delivery_address: { type: ['string', 'null'] },
    customer_first_name: { type: ['string', 'null'] },
    is_ready_to_order: { type: 'boolean' },
    reasoning: { type: 'string' },
  },
};

/**
 * Zod validator; `mapIntentPayload` does the coercion/clamping the legacy parser did.
 * P2-2 (F3): the contract's DECLARED RANGE is enforced here — a percentage-scale (C-63) or
 * negative score is a contract violation (retryable StructuredContractError), killing the
 * legacy '>1 ? /100' scale-guess class on the flag-on path.
 */
const intentPayloadSchema = z.object({ intent_score: z.number().min(0).max(1) }).passthrough();

function formatTranscript(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    if (!m.content?.trim()) continue;
    const speaker =
      m.direction === 'inbound' && m.sent_by === 'customer'
        ? 'Customer'
        : m.sent_by === 'ai'
          ? 'Assistant'
          : m.sent_by === 'human'
            ? 'Agent'
            : 'Other';
    lines.push(`${speaker}: ${m.content.trim()}`);
  }
  return lines.join('\n');
}

/** Legacy fail-open parse: on invalid JSON returns the all-zero intent (preserved under flag-off). */
function parseIntentJson(raw: string): IntentResult {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    logger.warn('[intentDetection] Failed to parse intent JSON response', {
      raw: logSafeStructured(raw),
    });
    return { ...EMPTY_INTENT_RESULT };
  }
  return mapIntentPayload(parsed);
}

/**
 * Detects purchase intent from recent chat messages using the tenant's configured OpenAI model.
 *
 * @param productNames - Optional list of active product names from the tenant catalog.
 *   When provided, the LLM is instructed to normalise the extracted product_name to the
 *   closest entry in this list, preventing free-form customer phrasings (e.g. "nga Muscletech"
 *   suffixes) from being recorded verbatim and failing the DB lookup step.
 */
export async function detect(
  conversationMessages: Message[],
  tenantId: string,
  productNames?: string[],
): Promise<IntentResult> {
  const transcript = formatTranscript(conversationMessages);
  if (!transcript.trim()) {
    return { ...EMPTY_INTENT_RESULT };
  }

  const model = OPENAI_INTENT_MODEL;

  const catalogSection =
    productNames && productNames.length > 0
      ? `\n\nAvailable products in catalog (you MUST use one of these exact names for product_name when the customer is ordering a product from this list; use null if the customer's product does not match any entry):\n${productNames.map((n) => `- ${n}`).join('\n')}`
      : '';

  const systemPrompt = `You are a precise purchase intent classifier for a sales business. Your job is to determine if a customer is actively trying to place an order RIGHT NOW — not just showing interest or asking questions.
A high intent score (above 0.75) requires ALL of the following signals to be present:

The customer has explicitly said they want to buy, order, or purchase — not just asking about price or availability
The customer has either named a specific product or confirmed a product from earlier in the conversation
The customer has either provided a quantity or confirmed one when asked
The customer has not asked any more clarifying questions in their latest message

A medium score (0.4 to 0.74) means the customer is interested but has not committed — they are asking about price, availability, or details.
A low score (below 0.4) means the customer is browsing, asking general questions, or the message is unrelated to purchasing.
Return JSON: { intent_score: number, product_name: string | null, quantity: number | null, items: Array<{ product_name: string, quantity: number | null }>, delivery_address: string | null, customer_first_name: string | null, is_ready_to_order: boolean, reasoning: string }
List EVERY distinct product the customer is ordering in the items array, each with its own quantity — when the customer orders more than one product (e.g. a protein AND a creatine), include one entry per product. Apply the same catalog-name normalization to each item's product_name as you do for the scalar product_name. Set the scalar product_name and quantity to the FIRST item (the primary product). When exactly one product is ordered, items has a single entry matching product_name/quantity. Use an empty items array only when no product is being ordered.
Extract customer_first_name when the customer explicitly provided it in the transcript (not from channel profile metadata), including multi-line order-detail messages where the first line is often the customer name before phone and address. Use null when missing or uncertain.
The is_ready_to_order field must only be true if intent_score is above 0.85 AND all four purchase signals above are present. Do not set is_ready_to_order to true based on intent_score alone.${catalogSection}

Respond with a single JSON object only (no markdown), matching that shape exactly.`;

  // P3-6: `intent` sends the whole transcript, so it is one of the larger prompts in the turn and
  // must be separable from the classifier fan-out in the COGS split.
  const completion = await withModelRole('intent', () =>
    openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Tenant context id: ${tenantId}\n\nTranscript:\n${transcript}`,
        },
      ],
      // Deterministic: purchase-intent gates draft-order creation against a fixed score
      // threshold, so any sampling randomness causes near-boundary messages to flip between
      // "create order" and "skip" across runs/retries.
      temperature: 0,
      max_tokens: 512,
      response_format: INTENT_STRUCTURED_CONTRACT
        ? buildJsonSchema('purchase_intent', INTENT_RESULT_SCHEMA)
        : ({ type: 'json_object' } as const),
    }),
  );

  const choice = completion.choices[0];
  const content = choice?.message?.content;
  if (!content) {
    throw new Error('OpenAI returned an empty intent detection response');
  }

  if (INTENT_STRUCTURED_CONTRACT) {
    // Strict json_schema: validate + map. A malformed/truncated payload throws a retryable
    // StructuredContractError (RC-22/I8 fail-closed) instead of the legacy all-zero fail-open.
    const payload = parseStructuredCompletion(content.trim(), {
      schema: intentPayloadSchema,
      finishReason: choice?.finish_reason,
      detector: 'purchase_intent',
    });
    return mapIntentPayload(payload as Record<string, unknown>);
  }

  return parseIntentJson(content.trim());
}
