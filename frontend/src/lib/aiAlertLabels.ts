const LABELS: Record<string, string> = {
  off_topic: 'Off-topic',
  unclear: 'Unclear',
  irrelevant: 'Irrelevant',
  misleading: 'Misleading',
  low_confidence: 'Low confidence',
  usage_question_unanswered: 'Usage question unanswered',
  cancellation_request: 'Cancellation request',
  refund_request: 'Refund request',
  post_purchase_support_request: 'Delivery or product issue',
  rate_limit_exceeded: 'AI rate limit exceeded',
  message_send_failed: 'Message send failed',
  token_refresh_failed: 'Token refresh failed',
};

export function formatFlagReason(reason: string): string {
  const key = reason.trim().toLowerCase().replace(/-/g, '_');
  if (key in LABELS) return LABELS[key];
  return reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
