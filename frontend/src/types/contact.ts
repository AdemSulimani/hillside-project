import type { ChannelType, InboxMessage } from '@/types/conversation';
import type { OrderListItem } from '@/types/order';

export type ContactListSortColumn = 'last_seen' | 'name' | 'message_count' | 'order_count';

export interface Contact {
  id: string;
  tenant_id: string;
  channel_id: string;
  external_id: string;
  name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ContactListItem extends Contact {
  message_count: number;
  order_count: number;
  last_seen: string | null;
}

export interface ContactConversationRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  last_message_at: string;
  human_override_until: string | null;
  created_at: string;
  updated_at: string;
  channel_type: ChannelType;
  channel_name: string;
  messages: InboxMessage[];
}

export interface ContactDetailPayload {
  contact: Contact;
  conversations: {
    data: ContactConversationRow[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
  orders: {
    data: OrderListItem[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}
