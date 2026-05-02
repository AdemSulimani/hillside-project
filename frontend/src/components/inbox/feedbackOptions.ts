import type { FeedbackReasonOption } from '@/types/feedback';

export const FEEDBACK_REASON_OPTIONS: { value: FeedbackReasonOption; label: string }[] = [
  { value: 'Wrong product info', label: 'Informacion i gabuar për produktin' },
  { value: 'Wrong tone', label: 'Ton i gabuar' },
  { value: 'Inaccurate', label: 'I pasaktë' },
  { value: 'Off-topic', label: 'Jashtë temës' },
  { value: 'Other', label: 'Tjetër' },
];

/** Shfaq arsyen e ruajtur në DB me etiketë shqipe kur përputhet me opsionet e njohura. */
export function feedbackReasonDisplay(stored: string | null | undefined): string {
  if (!stored?.trim()) return '—';
  const opt = FEEDBACK_REASON_OPTIONS.find((o) => o.value === stored);
  return opt?.label ?? stored;
}
