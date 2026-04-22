import { findTenantById } from '../db/models/tenant';
import { openai, OPENAI_EVAL_MODEL } from './openaiClient';

function evalModel(): string {
  return process.env.OPENAI_EVAL_MODEL?.trim() || 'gpt-4o-mini';
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
}

export function getQualityThreshold(): number {
  const t = parseFloat(process.env.QUALITY_THRESHOLD || '0.6');
  if (!Number.isFinite(t)) return 0.6;
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

  return {
    quality_score,
    is_off_topic: parsed.is_off_topic === true,
    is_unclear: parsed.is_unclear === true,
    is_irrelevant: parsed.is_irrelevant === true,
    reason: typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim() : null,
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

    const systemPrompt = `You are a strict quality evaluator for a business chatbot.
Return a single JSON object only (no markdown, no prose), exactly matching this shape:
{
  "quality_score": number,
  "is_off_topic": boolean,
  "is_unclear": boolean,
  "is_irrelevant": boolean,
  "reason": string | null
}

Definitions:
- quality_score: number from 0 to 1 (1 = excellent: directly answers the customer, clear, accurate, on-brand).
- is_off_topic: true if the reply is mostly unrelated to the customer's message or the business.
- is_unclear: true if the reply is vague, confusing, self-contradictory, or fails to address what was asked.
- is_irrelevant: true if the reply discusses unrelated topics or ignores the customer's intent.
- reason: short machine token if helpful, one of: off_topic | unclear | irrelevant | misleading | low_confidence — or null.

Rules:
- Judge whether the AI reply is directly related to "${businessName}", its products/services, and the customer's question.
- Small talk that appropriately greets or thanks is on-topic if it still addresses the thread.
- If unsure, lower quality_score and set is_unclear or is_irrelevant as appropriate.`;

    const userContent = `Tenant id (opaque): ${tenantId}

Customer message:
${inbound || '(no text; attachments or images may have been sent)'}

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
