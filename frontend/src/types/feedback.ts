export type FeedbackLogStatus = 'pending' | 'included_in_training';

export interface FeedbackLog {
  id: string;
  tenant_id: string;
  message_id: string;
  conversation_id: string;
  original_ai_response: string;
  corrected_response: string | null;
  reason: string | null;
  status: FeedbackLogStatus;
  created_at: string;
}

export type FeedbackReasonOption =
  | 'Wrong product info'
  | 'Wrong tone'
  | 'Inaccurate'
  | 'Off-topic'
  | 'Other';
