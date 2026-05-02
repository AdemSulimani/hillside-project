const LABELS: Record<string, string> = {
  off_topic: 'Jashtë temës',
  unclear: 'E paqartë',
  irrelevant: 'E parëndësishme',
  misleading: 'E rrejshme',
  low_confidence: 'Besim i ulët',
  usage_question_unanswered: 'Pyetje përdorimi pa përgjigje',
  cancellation_request: 'Kërkesë anulimi',
  refund_request: 'Kërkesë rimbursimi',
  post_purchase_support_request: 'Problem me dërgesën ose produktin',
  rate_limit_exceeded: 'U tejkalua kufiri i kërkesave të IA-së',
  message_send_failed: 'Dërgimi i mesazhit dështoi',
  token_refresh_failed: 'Rifreskimi i token-it dështoi',
};

export function formatFlagReason(reason: string): string {
  const key = reason.trim().toLowerCase().replace(/-/g, '_');
  if (key in LABELS) return LABELS[key];
  return reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
