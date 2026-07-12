/** Same copy as alert toasts and Alarmet IA guidance: manual reply, then close / resume from Alarmet IA. */
export const AI_ALERT_RESOLUTION_HINT =
  'First, reply manually in the conversation. After handling the issue, go to the AI Alerts page (in the sidebar) → Options → Close and Resume AI for this conversation (or Close alert if AI should remain paused).';

const LABELS: Record<string, string> = {
  off_topic: 'Off topic',
  unclear: 'Unclear',
  irrelevant: 'Irrelevant',
  misleading: 'Misleading',
  low_confidence: 'Low confidence',
  usage_question_unanswered: 'Usage question unanswered',
  product_question_unanswered: 'Product question unanswered',
  uncertain_answer_escalated: 'Uncertain answer — needs human reply',
  cancellation_request: 'Cancellation request',
  refund_request: 'Refund request',
  post_purchase_support_request: 'Delivery or product issue',
  order_detection_failed: 'Order detection failed — possible missed order',
  rate_limit_exceeded: 'AI rate limit exceeded',
  message_send_failed: 'Message sending failed',
  token_refresh_failed: 'Token refresh failed',
};

export function formatFlagReason(reason: string): string {
  const key = reason.trim().toLowerCase().replace(/-/g, '_');
  if (key in LABELS) return LABELS[key];
  return reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
