import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { ChannelType } from '@/types/conversation';

export async function fetchChatbotGlobalStatus(): Promise<boolean> {
  const { data } = await api.get<ApiResponse<{ is_active: boolean }>>('/chatbot/status');
  return Boolean(data.data?.is_active);
}

export async function toggleChatbotGlobal(): Promise<boolean> {
  const { data } = await api.patch<ApiResponse<{ is_active: boolean }>>('/chatbot/toggle');
  return Boolean(data.data?.is_active);
}

export interface PausedConversationItem {
  id: string;
  contact_name: string;
  channel_name: string;
  channel_type: ChannelType;
  updated_at: string;
}

function normalizePaused(raw: Record<string, unknown>): PausedConversationItem {
  return {
    id: String(raw.id),
    contact_name: String(raw.contact_name ?? ''),
    channel_name: String(raw.channel_name ?? ''),
    channel_type: (raw.channel_type as ChannelType) ?? 'facebook',
    updated_at: String(raw.updated_at ?? ''),
  };
}

export async function fetchPausedConversations(): Promise<PausedConversationItem[]> {
  const { data } = await api.get<
    ApiResponse<{ conversations: Record<string, unknown>[] }>
  >('/chatbot/paused-conversations');
  const rows = data.data?.conversations ?? [];
  return rows.map(normalizePaused);
}
