import type { Message } from '../db/models/message';
import { findAIConfigByTenant } from '../db/models/aiConfig';
import { groq, GROQ_MODEL } from './groqClient';

export interface IntentResult {
  intent_score: number;
  product_name: string | null;
  quantity: number | null;
  delivery_address: string | null;
  is_ready_to_order: boolean;
}

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

function parseIntentJson(raw: string): IntentResult {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  const intentScoreRaw = parsed.intent_score;
  let intent_score = 0;
  if (typeof intentScoreRaw === 'number' && Number.isFinite(intentScoreRaw)) {
    intent_score = intentScoreRaw > 1 ? intentScoreRaw / 100 : intentScoreRaw;
  }

  const product_name =
    typeof parsed.product_name === 'string' && parsed.product_name.trim()
      ? parsed.product_name.trim()
      : null;

  let quantity: number | null = null;
  if (typeof parsed.quantity === 'number' && Number.isFinite(parsed.quantity) && parsed.quantity > 0) {
    quantity = Math.floor(parsed.quantity);
  }

  const delivery_address =
    typeof parsed.delivery_address === 'string' && parsed.delivery_address.trim()
      ? parsed.delivery_address.trim()
      : null;

  const is_ready_to_order = parsed.is_ready_to_order === true;

  return {
    intent_score: Math.min(1, Math.max(0, intent_score)),
    product_name,
    quantity,
    delivery_address,
    is_ready_to_order,
  };
}

/**
 * Detects purchase intent from recent chat messages using the tenant's configured Groq model.
 */
export async function detect(
  conversationMessages: Message[],
  tenantId: string,
): Promise<IntentResult> {
  const transcript = formatTranscript(conversationMessages);
  if (!transcript.trim()) {
    return {
      intent_score: 0,
      product_name: null,
      quantity: null,
      delivery_address: null,
      is_ready_to_order: false,
    };
  }

  const config = await findAIConfigByTenant(tenantId);
  const model = config?.custom_model_id || GROQ_MODEL;

  const systemPrompt = `You analyze customer–business chat transcripts for purchase intent.
Respond with a single JSON object only (no markdown), matching this shape exactly:
{
  "intent_score": number,
  "product_name": string | null,
  "quantity": number | null,
  "delivery_address": string | null,
  "is_ready_to_order": boolean
}

Rules:
- intent_score is a number from 0 to 1 (1 = very strong purchase intent).
- product_name: the specific product or item the customer wants, or null if unclear.
- quantity: positive integer if stated or clearly implied, else null (default interpretation is 1 when ordering one item).
- delivery_address: shipping or delivery location if stated, else null.
- is_ready_to_order: true only if the customer has clearly committed to placing an order (e.g. confirmed they want to buy, sent address, or equivalent).`;

  const completion = await groq.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `Tenant context id: ${tenantId}\n\nTranscript:\n${transcript}`,
      },
    ],
    temperature: 0.2,
    max_tokens: 512,
    response_format: { type: 'json_object' },
  });

  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error('Groq returned an empty intent detection response');
  }

  return parseIntentJson(content.trim());
}
