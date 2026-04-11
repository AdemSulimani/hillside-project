import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type {
  ChannelType,
  ConversationDetail,
  ConversationSummary,
  ConversationThread,
  ConversationsListResult,
  InboxMessage,
} from '@/types/conversation';

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return Boolean(v);
}

export function normalizeConversationSummary(raw: Record<string, unknown>): ConversationSummary {
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    contact_id: String(raw.contact_id),
    channel_id: String(raw.channel_id),
    status: String(raw.status ?? 'open'),
    last_message_at: String(raw.last_message_at ?? ''),
    human_override_until:
      raw.human_override_until != null ? String(raw.human_override_until) : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
    contact_name: String(raw.contact_name ?? ''),
    contact_avatar_url:
      raw.contact_avatar_url != null ? String(raw.contact_avatar_url) : null,
    channel_type: (raw.channel_type as ChannelType) ?? 'facebook',
    last_message_content:
      raw.last_message_content != null ? String(raw.last_message_content) : null,
    last_message_created_at:
      raw.last_message_created_at != null ? String(raw.last_message_created_at) : null,
    has_outbound_message: toBool(raw.has_outbound_message),
  };
}

export function normalizeConversationDetail(raw: Record<string, unknown>): ConversationDetail {
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    contact_id: String(raw.contact_id),
    channel_id: String(raw.channel_id),
    status: String(raw.status ?? 'open'),
    last_message_at: String(raw.last_message_at ?? ''),
    human_override_until:
      raw.human_override_until != null ? String(raw.human_override_until) : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
    contact_name: String(raw.contact_name ?? ''),
    contact_avatar_url:
      raw.contact_avatar_url != null ? String(raw.contact_avatar_url) : null,
    contact_external_id: String(raw.contact_external_id ?? ''),
    channel_type: (raw.channel_type as ChannelType) ?? 'facebook',
    channel_name: String(raw.channel_name ?? ''),
  };
}

export function normalizeInboxMessage(raw: Record<string, unknown>): InboxMessage {
  const urls = raw.attachment_urls;
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    conversation_id: String(raw.conversation_id),
    external_message_id: String(raw.external_message_id ?? ''),
    direction: (raw.direction as InboxMessage['direction']) ?? 'inbound',
    type: String(raw.type ?? 'text'),
    content: raw.content != null ? String(raw.content) : null,
    attachment_urls: Array.isArray(urls) ? urls.map(String) : [],
    sent_by: (raw.sent_by as InboxMessage['sent_by']) ?? 'customer',
    ai_processed: toBool(raw.ai_processed),
    created_at: String(raw.created_at ?? ''),
  };
}

export interface FetchConversationsParams {
  page?: number;
  limit?: number;
  channel?: ChannelType;
  status?: 'open' | 'closed';
}

export async function fetchConversations(
  params: FetchConversationsParams = {},
): Promise<ConversationsListResult> {
  const { data } = await api.get<
    ApiResponse<{
      conversations: Record<string, unknown>[];
      pagination: ConversationsListResult['pagination'];
    }>
  >('/conversations', {
    params: {
      page: params.page ?? 1,
      limit: params.limit ?? 30,
      channel: params.channel,
      status: params.status,
    },
  });

  const payload = data.data!;
  return {
    conversations: (payload.conversations ?? []).map(normalizeConversationSummary),
    pagination: payload.pagination,
  };
}

export async function fetchUnreadConversationCount(): Promise<number> {
  const { data } = await api.get<ApiResponse<{ count: number }>>(
    '/conversations/unread-count',
  );
  return Number(data.data?.count ?? 0);
}

export async function fetchConversationThread(
  conversationId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<ConversationThread> {
  const { data } = await api.get<
    ApiResponse<{
      conversation: Record<string, unknown>;
      messages: Record<string, unknown>[];
      pagination: ConversationThread['pagination'];
    }>
  >(`/conversations/${conversationId}`, {
    params: {
      limit: opts.limit ?? 50,
      before: opts.before,
    },
  });

  const d = data.data!;
  return {
    conversation: normalizeConversationDetail(d.conversation as Record<string, unknown>),
    messages: (d.messages ?? []).map((m) => normalizeInboxMessage(m as Record<string, unknown>)),
    pagination: d.pagination,
  };
}

export interface ReplyResult {
  message: InboxMessage;
  channelDelivered: boolean;
}

export interface SendConversationReplyPayload {
  text: string;
  attachment_urls?: string[];
}

export async function uploadConversationAttachment(
  conversationId: string,
  file: File,
): Promise<string> {
  const formData = new FormData();
  formData.append('attachment', file);
  const { data } = await api.post<ApiResponse<{ url: string }>>(
    `/conversations/${conversationId}/attachments`,
    formData,
  );
  const url = data.data?.url;
  if (!url) {
    throw new Error('Upload response missing URL');
  }
  return String(url);
}

export async function sendConversationReply(
  conversationId: string,
  payload: SendConversationReplyPayload,
): Promise<ReplyResult> {
  const { data } = await api.post<
    ApiResponse<{ message: Record<string, unknown>; channelDelivered: boolean }>
  >(`/conversations/${conversationId}/reply`, {
    text: payload.text,
    attachment_urls: payload.attachment_urls ?? [],
  });

  return {
    message: normalizeInboxMessage(data.data!.message as Record<string, unknown>),
    channelDelivered: data.data!.channelDelivered !== false,
  };
}

export async function closeConversation(conversationId: string): Promise<ConversationDetail> {
  const { data } = await api.patch<ApiResponse<{ conversation: Record<string, unknown> }>>(
    `/conversations/${conversationId}/close`,
  );
  return normalizeConversationDetail(data.data!.conversation as Record<string, unknown>);
}

export async function reopenConversation(conversationId: string): Promise<ConversationDetail> {
  const { data } = await api.patch<ApiResponse<{ conversation: Record<string, unknown> }>>(
    `/conversations/${conversationId}/reopen`,
  );
  return normalizeConversationDetail(data.data!.conversation as Record<string, unknown>);
}
