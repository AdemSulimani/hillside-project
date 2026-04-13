import api from '@/lib/api';
import { normalizeOrderListItem } from '@/api/ordersApi';
import type { PaginatedResponse } from '@/types';
import type {
  Contact,
  ContactConversationRow,
  ContactDetailPayload,
  ContactListItem,
  ContactListSortColumn,
} from '@/types/contact';
import type { ChannelType } from '@/types/conversation';
import type { InboxMessage } from '@/types/conversation';

function toInt(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function normalizeContact(raw: Record<string, unknown>): Contact {
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    channel_id: String(raw.channel_id),
    external_id: String(raw.external_id ?? ''),
    name: String(raw.name ?? ''),
    avatar_url: raw.avatar_url != null ? String(raw.avatar_url) : null,
    metadata:
      raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : {},
    notes: raw.notes != null ? String(raw.notes) : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

function normalizeContactListItem(raw: Record<string, unknown>): ContactListItem {
  const base = normalizeContact(raw);
  return {
    ...base,
    message_count: toInt(raw.message_count),
    order_count: toInt(raw.order_count),
    last_seen: raw.last_seen != null ? String(raw.last_seen) : null,
  };
}

function normalizeInboxMessage(raw: Record<string, unknown>): InboxMessage {
  const urls = raw.attachment_urls;
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    conversation_id: String(raw.conversation_id),
    external_message_id: String(raw.external_message_id ?? ''),
    direction: raw.direction === 'outbound' ? 'outbound' : 'inbound',
    type: String(raw.type ?? 'text'),
    content: raw.content != null ? String(raw.content) : null,
    attachment_urls: Array.isArray(urls) ? urls.map(String) : [],
    sent_by:
      raw.sent_by === 'ai' || raw.sent_by === 'human' ? raw.sent_by : 'customer',
    ai_processed: Boolean(raw.ai_processed),
    created_at: String(raw.created_at ?? ''),
    quality_score: raw.quality_score != null ? Number(raw.quality_score) : null,
    flagged: Boolean(raw.flagged),
    flag_reason: raw.flag_reason != null ? String(raw.flag_reason) : null,
  };
}

function normalizeConversationRow(raw: Record<string, unknown>): ContactConversationRow {
  const msgs = Array.isArray(raw.messages) ? raw.messages : [];
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    contact_id: String(raw.contact_id),
    channel_id: String(raw.channel_id),
    status: String(raw.status ?? ''),
    last_message_at: String(raw.last_message_at ?? ''),
    human_override_until:
      raw.human_override_until != null ? String(raw.human_override_until) : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
    channel_type: (raw.channel_type as ChannelType) ?? 'whatsapp',
    channel_name: String(raw.channel_name ?? ''),
    messages: msgs.map((m) => normalizeInboxMessage(m as Record<string, unknown>)),
  };
}

export async function fetchContacts(params: {
  page?: number;
  limit?: number;
  search?: string;
  sort?: ContactListSortColumn;
  sort_dir?: 'asc' | 'desc';
}): Promise<{ contacts: ContactListItem[]; pagination: PaginatedResponse<ContactListItem>['pagination'] }> {
  const { data } = await api.get<PaginatedResponse<Record<string, unknown>>>('/contacts', {
    params: {
      page: params.page ?? 1,
      limit: params.limit ?? 20,
      search: params.search?.trim() || undefined,
      sort: params.sort,
      sort_dir: params.sort_dir ?? 'desc',
    },
  });

  const contacts = (data.data ?? []).map((row) => normalizeContactListItem(row));
  return { contacts, pagination: data.pagination };
}

export async function fetchContactDetail(
  id: string,
  query?: {
    conversations_page?: number;
    conversations_limit?: number;
    orders_page?: number;
    orders_limit?: number;
    messages_limit?: number;
  },
): Promise<ContactDetailPayload> {
  const { data } = await api.get<{
    success: boolean;
    data: {
      contact: Record<string, unknown>;
      conversations: {
        data: Record<string, unknown>[];
        pagination: ContactDetailPayload['conversations']['pagination'];
      };
      orders: {
        data: Record<string, unknown>[];
        pagination: ContactDetailPayload['orders']['pagination'];
      };
    };
  }>(`/contacts/${id}`, {
    params: {
      conversations_page: query?.conversations_page ?? 1,
      conversations_limit: query?.conversations_limit ?? 10,
      orders_page: query?.orders_page ?? 1,
      orders_limit: query?.orders_limit ?? 20,
      messages_limit: query?.messages_limit ?? 100,
    },
  });

  const payload = data.data;
  if (!payload?.contact) {
    throw new Error('Invalid contact detail response');
  }

  return {
    contact: normalizeContact(payload.contact),
    conversations: {
      data: (payload.conversations?.data ?? []).map((r) => normalizeConversationRow(r)),
      pagination: payload.conversations.pagination,
    },
    orders: {
      data: (payload.orders?.data ?? []).map((r) => normalizeOrderListItem(r)),
      pagination: payload.orders.pagination,
    },
  };
}

export async function updateContact(
  id: string,
  body: { name?: string; notes?: string | null },
): Promise<Contact> {
  const { data } = await api.put<{ success: boolean; data: { contact: Record<string, unknown> } }>(
    `/contacts/${id}`,
    body,
  );
  return normalizeContact(data.data.contact);
}
