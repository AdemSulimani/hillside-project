/**
 * The reply-quality evaluator's NETWORK call.
 *
 * Since P3-4 (RC-15) everything that can be decided without a network call lives in
 * `aiQualityContract.ts` — the verdict rules, the score rescale, the threshold comparison, the
 * flag-reason mapping and both prompt builders. Only `evaluateReply` remains here, because only it
 * needs `openaiClient` (which throws at module load without `OPENAI_API_KEY`, making anything in
 * this file unimportable by a test).
 *
 * The contract is re-exported below so the ~5 existing call sites did not have to change.
 *
 * WHERE THIS IS HEADED. RC-15's remediation is to take this call off the send path entirely. The
 * `QUALITY_EVAL_MODE` knob (`enforce` | `shadow` | `off`) is the cutover control, and
 * `eval/quality/offlineScorer.ts` is the replacement — it reuses the SAME prompt builders and the
 * SAME parser from the contract module, so the two are comparable by construction.
 */
import { findTenantById } from '../db/models/tenant';
import { openai, OPENAI_EVAL_MODEL } from './openaiClient';
import { logger } from '../utils/logger';
import {
  buildQualityEvalSystemPrompt,
  buildQualityEvalUserContent,
  parseEvaluationJson,
  type ReplyQualityEvaluation,
} from './aiQualityContract';

// Re-exported so existing importers (jobs/processAIReply.ts and friends) keep working unchanged.
export {
  FLAG_REASON_VALUES,
  buildQualityEvalSystemPrompt,
  buildQualityEvalUserContent,
  evaluationTriggersAlert,
  getQualityEvalMode,
  getQualityThreshold,
  parseEvaluationJson,
  resolveStoredFlagReason,
  type QualityEvalMode,
  type ReplyQualityEvaluation,
  type StoredFlagReason,
} from './aiQualityContract';

function evalModel(): string {
  return OPENAI_EVAL_MODEL;
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
  const reply = aiReply.trim();
  if (!reply) {
    return null;
  }

  try {
    const tenant = await findTenantById(tenantId);
    const businessName = tenant?.name ?? 'the business';

    const completion = await openai.chat.completions.create({
      model: evalModel(),
      messages: [
        { role: 'system', content: buildQualityEvalSystemPrompt(businessName) },
        {
          role: 'user',
          content: buildQualityEvalUserContent(inboundMessage, aiReply, productCatalogContext),
        },
      ],
      // Deterministic: the quality score gates flagging/pausing against a fixed threshold,
      // so sampling randomness would make the same reply flip between flagged and clean.
      temperature: 0,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
      logger.warn('[aiQuality] Empty evaluator response');
      return null;
    }

    return parseEvaluationJson(content.trim());
  } catch (err) {
    // Fall-open degradation (returns null → reply proceeds unevaluated), and this eval runs on
    // every reply — so warn (not error/Sentry) to avoid flooding on transient OpenAI blips.
    logger.warn('[aiQuality] evaluateReply failed', {
      tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
