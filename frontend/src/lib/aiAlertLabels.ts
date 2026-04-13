import type { AIAlertFlagReason } from '@/types/aiAlert';

const LABELS: Record<AIAlertFlagReason, string> = {
  off_topic: 'Off-topic',
  unclear: 'Unclear',
  irrelevant: 'Irrelevant',
  misleading: 'Misleading',
  low_confidence: 'Low confidence',
};

export function formatFlagReason(reason: string): string {
  const key = reason.trim().toLowerCase().replace(/-/g, '_') as AIAlertFlagReason;
  if (key in LABELS) return LABELS[key];
  return reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
