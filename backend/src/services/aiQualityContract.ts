/**
 * P3-4 (RC-15) — the reply-quality evaluation CONTRACT, extracted as a leaf module.
 *
 * WHY THIS FILE EXISTS. Everything here used to live in `aiQualityService.ts`, which imports
 * `./openaiClient` — and that module THROWS AT LOAD without `OPENAI_API_KEY`. The consequence was
 * that none of this logic could be imported by a test: the verdict rules, the score rescale, the
 * threshold comparison and the flag-reason mapping all decide whether a customer's conversation
 * gets PAUSED, and every one of them had zero test coverage. Splitting the contract from the
 * network call fixes that, and it is also the precondition for RC-15's actual remediation.
 *
 * WHAT RC-15 IS. The quality eval sits ON THE SEND PATH and is miscalibrated: it scores order
 * confirmations a systematic 0.200 (EV-018), while a degenerate one-word "Po." scored 0.20 and
 * shipped. The live floor is 0.1, which makes the miscalibration inert; `.env.example` shipped 0.6
 * until P0-2 reconciled it, and at 0.6 every order confirmation would flag and PAUSE THE AI AT
 * CHECKOUT with no auto-resume (RC-14). The remediation is not a better threshold — it is moving
 * the eval OFF the send path, "where its miscalibration can do no billing damage". This module is
 * what lets the offline replacement score a reply identically to the inline one: both call the
 * SAME prompt builders and the SAME parser. If the offline runner rebuilt the prompt even slightly
 * differently, the "do the scores match?" comparison that gates the cutover would be worthless.
 *
 * INVARIANT — LEAF MODULE: imports only `config/knobs` (itself a leaf). No OpenAI, no DB, no Redis.
 * `eval/goldenSets/__tests__/harnessOfflineFence.test.ts` keeps it that way.
 */
import { knobNumber, knobString } from '../config/knobs';

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

/**
 * How the quality eval participates in a customer turn (P3-4, RC-15).
 *
 *   - `enforce` (default) — today's behaviour, byte-identical: score inline, and a failing score
 *     flags the message, raises an `ai_alerts` row and PAUSES the conversation.
 *   - `shadow`  — still score inline and still record the score in the P1-5 ledger, but take no
 *     action. This is the parallel/log-only window the remediation plan asks for: it produces the
 *     data the offline replacement is compared against, without the miscalibration being able to
 *     pause anyone.
 *   - `off`     — skip the call entirely. One fewer LLM call on the customer's turn.
 *
 * Enum rather than two booleans, matching `ORDER_STAGE_MACHINE`'s proven off|shadow|on shape: the
 * states are ordered and mutually exclusive, and two independent flags would admit a meaningless
 * fourth combination.
 */
export type QualityEvalMode = 'enforce' | 'shadow' | 'off';

export function getQualityEvalMode(): QualityEvalMode {
  const v = knobString('QUALITY_EVAL_MODE');
  return v === 'shadow' || v === 'off' ? v : 'enforce';
}

export function getQualityThreshold(): number {
  return knobNumber('QUALITY_THRESHOLD');
}

export function evaluationTriggersAlert(e: ReplyQualityEvaluation, threshold: number): boolean {
  // Do not treat is_unclear alone as a hard fail: evaluators often mark short or
  // non-English replies "unclear" even when they correctly answer the customer.
  return e.is_off_topic || e.is_irrelevant || e.quality_score < threshold;
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

/**
 * Parse an evaluator completion.
 *
 * Two normalizations that are easy to overlook and both load-bearing:
 *  - a missing or non-numeric score becomes 0.5, NOT 0. Defaulting to zero would make every parse
 *    failure look like a catastrophic reply and (above a non-trivial threshold) pause the AI.
 *  - a score above 1 is treated as a percentage and divided by 100 — evaluators return "85" about
 *    as often as "0.85", and without this the same verdict would clamp to 1.0.
 *
 * Exported because the offline scorer MUST reuse it: two parsers that disagree by a rounding rule
 * would show up as a score mismatch and be misread as evaluator drift.
 */
export function parseEvaluationJson(raw: string): ReplyQualityEvaluation {
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
 * The evaluator system prompt. Exported so the offline scorer uses the IDENTICAL text — the whole
 * point of the parity comparison is that only the CALL SITE differs, never the prompt.
 */
export function buildQualityEvalSystemPrompt(businessName: string): string {
  return `You are a precise quality evaluator for an AI sales assistant. Your job is to determine if the AI gave a BAD response — not just a negative-sounding one.
IMPORTANT RULES you must follow:

Rule 1 — A response saying 'we do not have this product' or 'this item is not available' is CORRECT and should score 0.9 or higher if the product genuinely does not appear in the catalog context provided. Never flag honest negative responses as low quality.

Rule 1b — If the customer asked whether you have / stock / price of a product and the AI confirms availability, names the product, gives a price that matches the catalog (or is consistent with it), that is an EXCELLENT reply. Score 0.92 or higher and set is_off_topic, is_irrelevant, and is_unclear all to false. A polite follow-up such as asking if they need more information is professional, not irrelevant.

Rule 1c — Customers may write in any language (including Albanian). Replies in the same language as the customer are preferred. Never penalize a reply for not being in English.

Rule 1d — If the AI asks for order-required details (for example: customer name, delivery/shipping address, phone number, quantity, variant/flavor, or other information needed to proceed with an order), that is ON-TOPIC and should score 0.9 or higher when it logically follows the customer intent to buy/order. Do not mark these replies as off-topic or irrelevant.

Rule 2 — Only flag a response as low quality if it meets one of these conditions:

The AI gave a completely irrelevant response that does not address what the customer asked

The AI made up information that is not in the catalog or business context

The AI response is internally contradictory or nonsensical

The AI made a factual error about a product that IS in the catalog (wrong price, wrong name, wrong availability)

The AI was rude, dismissive, or unprofessional

Rule 3 — Do NOT flag a response as low quality just because:

It is short
It says the product is not available
It does not make a sale
The customer seems unhappy
It ends with a question offering further help

Rule 4 — Use is_unclear sparingly: set it true only if a reasonable reader could not understand what the AI is telling the customer or what they should do next. A brief in-stock answer with price is clear; do not set is_unclear for those.

You will be given: the customer's message, the AI's reply, and the product catalog context available to the AI.
Return JSON: { quality_score: number, is_off_topic: boolean, is_unclear: boolean, is_irrelevant: boolean, reason: string | null, flagging_rule_triggered: string | null }

Return a single JSON object only (no markdown, no prose), exactly matching that shape. Business name for tone context: "${businessName}".`;
}

/** The evaluator user message. Exported for the same reason as the system prompt. */
export function buildQualityEvalUserContent(
  inboundMessage: string,
  aiReply: string,
  productCatalogContext: string,
): string {
  const catalogBlock = productCatalogContext.trim() || '(no catalog context provided)';
  const inboundForEval =
    inboundMessage.trim() || '(no text; attachments or images may have been sent)';
  return `Customer message: "${inboundForEval}"

Product catalog available to AI:
${catalogBlock}

AI reply to evaluate:
"${aiReply.trim()}"

Based on the catalog above, was the AI reply correct and accurate?
If the AI said a product is not available and that product genuinely does not appear in the catalog above, the reply is CORRECT and must score above 0.85. Do not flag honest negative responses.`;
}
