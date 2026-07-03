import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { Channel } from '@/types/channel';

function normalizeChannel(raw: Record<string, unknown>): Channel {
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    type: String(raw.type) as Channel['type'],
    name: String(raw.name ?? ''),
    external_id: String(raw.external_id ?? ''),
    connection_method: String(raw.connection_method ?? 'oauth_meta') as Channel['connection_method'],
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

export async function getMetaRedirectUrl(): Promise<string> {
  const { data } = await api.get<ApiResponse<{ url: string }>>('/oauth/meta/redirect');
  return data.data!.url;
}

export async function getInstagramRedirectUrl(): Promise<string> {
  const { data } = await api.get<ApiResponse<{ url: string }>>('/oauth/instagram/redirect');
  return data.data!.url;
}

export async function getWhatsAppSignupState(): Promise<{ state: string }> {
  const { data } = await api.get<ApiResponse<{ state: string }>>('/channels/whatsapp/signup-state');
  const state = data.data?.state;
  if (!state) {
    throw new Error('Signup state was not returned by the server.');
  }
  return { state };
}

export async function connectWhatsAppEmbeddedSignup(body: {
  code: string;
  state: string;
}): Promise<Channel> {
  const { data } = await api.post<ApiResponse<{ channel: Record<string, unknown> }>>(
    '/channels/whatsapp/embedded-signup',
    body,
  );
  const raw = data.data?.channel;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Channel was not returned by the server.');
  }
  return normalizeChannel(raw as Record<string, unknown>);
}

export async function connectViber(authToken: string): Promise<Channel> {
  const { data } = await api.post<ApiResponse<{ channel: Record<string, unknown> }>>(
    '/channels/viber/connect',
    { auth_token: authToken },
  );
  const raw = data.data?.channel;
  if (!raw || typeof raw !== 'object') {
    throw new Error('Channel was not returned by the server.');
  }
  return normalizeChannel(raw as Record<string, unknown>);
}
