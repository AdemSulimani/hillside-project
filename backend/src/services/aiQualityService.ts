import { findTenantById } from '../db/models/tenant';
import { openai, OPENAI_EVAL_MODEL } from './openaiClient';

function evalModel(): string {
  return process.env.OPENAI_EVAL_MODEL?.trim() || OPENAI_EVAL_MODEL;
}

export const FLAG_REASON_VALUES = [
  'off_topic',
  'unclear',
  'irrelevant',
  'misleading',
  'low_confidence',
] as const;

export type StoredFlagReason = (typeof FLAG_REASON_VALUES)[number];

export interface ReplyQualityEvaluation {
  quality_score: number;
  is_off_topic: boolean;
  is_unclear: boolean;
  is_irrelevant: boolean;
  reason: string | null;
  flagging_rule_triggered: string | null;
}

export function getQualityThreshold(): number {
  const t = parseFloat(process.env.QUALITY_THRESHOLD || '0.45');
  if (!Number.isFinite(t)) return 0.45;
  return Math.min(1, Math.max(0, t));
}

export function evaluationTriggersAlert(e: ReplyQualityEvaluation, threshold: number): boolean {
  return e.is_off_topic || e.is_unclear || e.is_irrelevant || e.quality_score < threshold;
}

function normalizeReasonToken(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, '_');
  if (!s) return null;
  if (FLAG_REASON_VALUES.includes(s as StoredFlagReason)) return s;
  if (s === 'off-topic' || s === 'offtopic') return 'off_topic';
  return null;
}

/**
 * Maps evaluator output to a stored `flag_reason` for messages / alerts.
 */
export function resolveStoredFlagReason(
  e: ReplyQualityEvaluation,
  threshold: number,
): StoredFlagReason {
  const fromModel = normalizeReasonToken(e.reason);
  const r = (e.reason ?? '').toLowerCase();

  if (r.includes('mislead') || fromModel === 'misleading') {
    return 'misleading';
  }
  if (e.is_off_topic) return 'off_topic';
  if (e.is_irrelevant) return 'irrelevant';
  if (e.is_unclear) return 'unclear';
  if (e.quality_score < threshold) return 'low_confidence';
  if (fromModel) return fromModel as StoredFlagReason;
  return 'low_confidence';
}

function parseEvaluationJson(raw: string): ReplyQualityEvaluation {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  let quality_score = 0.5;
  const qs = parsed.quality_score;
  if (typeof qs === 'number' && Number.isFinite(qs)) {
    quality_score = qs > 1 ? qs / 100 : qs;
  }
  quality_score = Math.min(1, Math.max(0, quality_score));

  const flagging_rule_triggered =
    typeof parsed.flagging_rule_triggered === 'string' && parsed.flagging_rule_triggered.trim()
      ? parsed.flagging_rule_triggered.trim()
      : null;

  return {
    quality_score,
    is_off_topic: parsed.is_off_topic === true,
    is_unclear: parsed.is_unclear === true,
    is_irrelevant: parsed.is_irrelevant === true,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null,
    flagging_rule_triggered,
  };
}

/**
 * Lightweight OpenAI call: judges whether the outbound AI reply fits the business context
 * and the customer's question. Returns null if evaluation could not be completed.
 */
export async function evaluateReply(
  inboundMessage: string,
  aiReply: string,
  tenantId: string,
  productCatalogContext: string,
): Promise<ReplyQualityEvaluation | null> {
  const inbound = inboundMessage.trim();
  const reply = aiReply.trim();
  if (!reply) {
    return null;
  }

  try {
    const tenant = await findTenantById(tenantId);
    const businessName = tenant?.name ?? 'the business';
    const model = evalModel();

    const systemPrompt = `You are a precise quality evaluator for an AI sales assistant. Your job is to determine if the AI gave a BAD response — not just a negative-sounding one.
IMPORTANT RULES you must follow:

Rule 1 — A response saying 'we do not have this product' or 'this item is not available' is CORRECT and should score 0.9 or higher if the product genuinely does not appear in the catalog context provided. Never flag honest negative responses as low quality.

Rule 2 — Only flag a response as low quality if it meets one of these conditions:

The AI made up information that is not in the catalog or business context

The AI gave a completely irrelevant response that does not address what the customer asked

The AI response is internally contradictory or nonsensical
The AI made a factual error about a product that IS in the catalog (wrong price, wrong name, wrong availability)

The AI was rude, dismissive, or unprofessional

Rule 3 — Do NOT flag a response as low quality just because:

It is short
It says the product is not available
It does not make a sale
The customer seems unhappy

You will be given: the customer's message, the AI's reply, and the product catalog context available to the AI.
Return JSON: { quality_score: number, is_off_topic: boolean, is_unclear: boolean, is_irrelevant: boolean, reason: string | null, flagging_rule_triggered: string | null }

Return a single JSON object only (no markdown, no prose), exactly matching that shape. Business name for tone context: "${businessName}".`;

    const catalogBlock = productCatalogContext.trim() || '(no catalog context provided)';

    const userContent = `Tenant id (opaque): ${tenantId}

Customer message:
${inbound || '(no text; attachments or images may have been sent)'}

Product catalog context available to the AI:
${catalogBlock}

AI reply to evaluate:
${reply}`;

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      console.warn('[aiQuality] Empty evaluator response');
      return null;
    }

    return parseEvaluationJson(content.trim());
  } catch (err) {
    console.error('[aiQuality] evaluateReply failed', { tenantId, err });
    return null;
  }
}
