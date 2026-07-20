/**
 * Mirror of the backend's `backend/src/services/alertPausePolicy.ts` (the two-package repo has
 * no shared-code path — same precedent as the SENSITIVE_ALERT_REASONS mirror in AIAlertsPage).
 * The backend module is pinned against the real pipeline by
 * `backend/src/services/__tests__/alertPausePolicy.test.ts`; keep this map in sync with it.
 *
 * Drift here only mislabels a badge — it can never change pause behavior, which lives entirely
 * in the backend.
 */

export type AlertSeverity = 'escalation' | 'notification' | 'unknown';

const PAUSING_REASONS = new Set([
  'cancellation_request',
  'refund_request',
  'post_purchase_support_request',
  'usage_question_unanswered',
  'product_question_unanswered',
  'uncertain_answer_escalated',
  'hallucinated_price',
  'hallucinated_product_name',
  'hallucinated_product_attribute',
  'grounding_check_unavailable',
  'off_topic',
  'unclear',
  'irrelevant',
  'misleading',
  'low_confidence',
  'rate_limit_exceeded',
]);

const NOTIFY_ONLY_REASONS = new Set([
  'confidence_band_abstain',
  'provider_unavailable',
  'order_info_updated',
  'product_image_unavailable',
  'message_send_failed',
  'order_detection_failed',
  'ai_reply_undelivered',
  'prompt_assembly_violation',
  'token_refresh_failed',
  'multiple_channels_matched',
]);

/**
 * How an alert relates to the AI's state in its conversation: an `escalation` comes with a
 * paused AI that waits for a human; a `notification` is informational and the AI keeps
 * replying. Unknown reasons get no badge rather than a guess.
 */
export function alertSeverity(reason: string): AlertSeverity {
  const key = reason.trim().toLowerCase().replace(/-/g, '_');
  if (PAUSING_REASONS.has(key)) return 'escalation';
  if (NOTIFY_ONLY_REASONS.has(key)) return 'notification';
  return 'unknown';
}
