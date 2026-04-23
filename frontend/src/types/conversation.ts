export type ChannelType = 'facebook' | 'instagram' | 'whatsapp';

/** Latest non-resolved AI quality alert on a conversation (from API). */
export interface OpenAIAlertSummary {
  id: string;
  reason: string;
  status: 'unread' | 'read';
}

export type MessageDirection = 'inbound' | 'outbound';
export type MessageSender = 'customer' | 'ai' | 'human';

/** One row in the inbox conversation list (from GET /conversations). */
export interface ConversationSummary {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  last_message_at: string;
  human_override_until: string | null;
  ai_paused: boolean;
  created_at: string;
  updated_at: string;
  contact_name: string;
  contact_avatar_url: string | null;
  channel_type: ChannelType;
  last_message_content: string | null;
  last_message_created_at: string | null;
  has_outbound_message: boolean;
  has_unread_ai_alert: boolean;
}

export interface ConversationDetail {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  last_message_at: string;
  human_override_until: string | null;
  ai_paused: boolean;
  created_at: string;
  updated_at: string;
  contact_name: string;
  contact_avatar_url: string | null;
  contact_external_id: string;
  channel_type: ChannelType;
  channel_name: string;
  open_ai_alert: OpenAIAlertSummary | null;
}

export interface InboxMessage {
  id: string;
  tenant_id: string;
  conversation_id: string;
  external_message_id: string;
  direction: MessageDirection;
  type: string;
  content: string | null;
  attachment_urls: string[];
  sent_by: MessageSender;
  ai_processed: boolean;
  created_at: string;
  quality_score: number | null;
  flagged: boolean;
  flag_reason: string | null;
  send_status: string | null;
  send_error: string | null;
}

export interface ConversationThread {
  conversation: ConversationDetail;
  messages: InboxMessage[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
  };
}

export interface ConversationsListResult {
  conversations: ConversationSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
