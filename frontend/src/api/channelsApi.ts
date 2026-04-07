import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { Channel, WhatsAppConnectBody } from '@/types/channel';

function normalizeChannel(raw: Record<string, unknown>): Channel {
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    type: String(raw.type) as Channel['type'],
    name: String(raw.name ?? ''),
    external_id: String(raw.external_id ?? ''),
    webhook_verified: Boolean(raw.webhook_verified),
    ai_enabled: Boolean(raw.ai_enabled),
    metadata:
      raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

export async function fetchChannels(): Promise<Channel[]> {
  const { data } = await api.get<ApiResponse<{ channels: Record<string, unknown>[] }>>('/channels');
  const rows = data.data?.channels ?? [];
  return rows.map(normalizeChannel);
}

export async function deleteChannel(id: string): Promise<void> {
  await api.delete(`/channels/${id}`);
}

export async function toggleChannelAI(id: string): Promise<Channel> {
  const { data } = await api.patch<ApiResponse<{ channel: Record<string, unknown> }>>(
    `/channels/${id}/toggle-ai`,
  );
  return normalizeChannel(data.data!.channel);
}

export async function getMetaRedirectUrl(type: 'facebook' | 'instagram'): Promise<string> {
  const { data } = await api.get<ApiResponse<{ url: string }>>('/oauth/meta/redirect', {
    params: { type },
  });
  return data.data!.url;
}

export async function connectWhatsApp(body: WhatsAppConnectBody): Promise<{ channelId: string }> {
  const { data } = await api.post<ApiResponse<{ channelId: string }>>(
    '/channels/whatsapp/connect',
    body,
  );
  return { channelId: data.data!.channelId };
}
