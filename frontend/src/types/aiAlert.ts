import type { ChannelType } from '@/types/conversation';

export type AIAlertStatus = 'unread' | 'read' | 'resolved';

export type AIAlertFlagReason =
  | 'off_topic'
  | 'unclear'
  | 'irrelevant'
  | 'misleading'
  | 'low_confidence';

export interface AIAlertRow {
  id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  reason: AIAlertFlagReason | string;
  status: AIAlertStatus;
  created_at: string;
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
  message_content: string | null;
  quality_score: number | null;
  customer_question?: string | null;
  product_id?: string | null;
  product_name?: string | null;
  usage_description?: string | null;
}

/** Socket.io `ai_alert` payload (matches backend). */
export interface AIAlertSocketPayload {
  id: string;
  tenant_id: string;
  conversation_id: string;
  message_id: string;
  reason: string;
  status: AIAlertStatus;
  created_at: string;
  message_content: string | null;
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
}
