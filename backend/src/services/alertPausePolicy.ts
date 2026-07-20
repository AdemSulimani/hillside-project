/**
 * The alert-reason → pause-behavior policy, in one place.
 *
 * Alert creation (`createAIAlert`) and pausing (`setConversationAiPaused`) are DELIBERATELY
 * decoupled: each escalation branch in `jobs/processAIReply.ts` wires its own pause next to its
 * own alert, because the right coupling differs per reason (transactional for the fail-closed
 * paths, post-ack for cancellation/refund, none at all for notifications). That flexibility has
 * a cost — nothing in the code says which reasons pause and which don't, so the split exists
 * only as ~21 scattered call sites and an operator's guess. This module is the missing
 * statement of record.
 *
 * DESCRIPTIVE, NOT AUTHORITATIVE. The pipeline does NOT read this map — rewiring the inline
 * pause calls through a lookup would put a data structure between a refund demand and its
 * pause. Instead `__tests__/alertPausePolicy.test.ts` pins this map against the pipeline
 * source, so a new alert reason or a changed pause wiring fails the suite until the policy
 * here (and the frontend mirror, `frontend/src/lib/alertPausePolicy.ts`) is updated.
 *
 * The split itself, for reference:
 *  - `pauses`: the CONVERSATION needs a human — the AI stays silent until an explicit resume
 *    (or the P0-5 auto-resume where it applies, e.g. `rate_limit_exceeded`).
 *  - `notify_only`: informational — the AI keeps replying. `provider_unavailable` is the
 *    load-bearing case: a provider outage is GLOBAL, and pausing would fan one blip out into
 *    O(conversations) sticky-paused threads (P2-6, CLAUDE.md §11). `confidence_band_abstain`
 *    is a boundary-ambiguity note, `product_image_unavailable` a catalog-content gap,
 *    `message_send_failed`/`ai_reply_undelivered` delivery failures with their own retries,
 *    and the null-conversation reasons (`prompt_assembly_violation`, `token_refresh_failed`,
 *    `multiple_channels_matched`) are tenant/system-scoped — there is no conversation to pause.
 *
 * Pure and import-free on purpose (the `aiResumePolicy` posture): importable from anywhere,
 * including the frontend mirror's cross-reference, without dragging in a DB connection.
 */

export type AlertPauseBehavior = 'pauses' | 'notify_only';

export const ALERT_PAUSE_POLICY = {
  // ── pauses — the conversation needs a human ────────────────────────────────
  cancellation_request: 'pauses',
  refund_request: 'pauses',
  post_purchase_support_request: 'pauses',
  usage_question_unanswered: 'pauses',
  product_question_unanswered: 'pauses',
  uncertain_answer_escalated: 'pauses',
  // grounding gate (GroundingReason) — grounding_check_unavailable pauses too: the gate
  // fails CLOSED when it cannot verify a reply (see groundingGate.ts).
  hallucinated_price: 'pauses',
  hallucinated_product_name: 'pauses',
  hallucinated_product_attribute: 'pauses',
  grounding_check_unavailable: 'pauses',
  // quality-eval flag reasons (FLAG_REASON_VALUES in aiQualityContract.ts)
  off_topic: 'pauses',
  unclear: 'pauses',
  irrelevant: 'pauses',
  misleading: 'pauses',
  low_confidence: 'pauses',
  // auto-resumable via P0-5 (RC-14) once the rate window rolls over
  rate_limit_exceeded: 'pauses',
  // ── notify_only — informational; the AI keeps replying ─────────────────────
  confidence_band_abstain: 'notify_only',
  provider_unavailable: 'notify_only',
  order_info_updated: 'notify_only',
  product_image_unavailable: 'notify_only',
  message_send_failed: 'notify_only',
  order_detection_failed: 'notify_only',
  ai_reply_undelivered: 'notify_only',
  prompt_assembly_violation: 'notify_only',
  token_refresh_failed: 'notify_only',
  multiple_channels_matched: 'notify_only',
} as const satisfies Record<string, AlertPauseBehavior>;

export type KnownAlertReason = keyof typeof ALERT_PAUSE_POLICY;

/**
 * Does an alert with this reason come with a paused conversation? `null` for a reason this
 * policy does not know — callers should treat unknown as "look at the conversation row", never
 * assume either way.
 */
export function alertReasonPauses(reason: string | null | undefined): boolean | null {
  if (reason == null) return null;
  const behavior = (ALERT_PAUSE_POLICY as Record<string, AlertPauseBehavior>)[reason];
  if (behavior === undefined) return null;
  return behavior === 'pauses';
}
