import type { FeedbackReasonOption } from '@/types/feedback';

export const FEEDBACK_REASON_OPTIONS: { value: FeedbackReasonOption; label: string }[] = [
  { value: 'Wrong product info', label: 'Wrong product info' },
  { value: 'Wrong tone', label: 'Wrong tone' },
  { value: 'Inaccurate', label: 'Inaccurate' },
  { value: 'Off-topic', label: 'Off-topic' },
  { value: 'Other', label: 'Other' },
];
