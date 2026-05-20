import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { TenantAIConfigPublic } from '@/types/aiConfig';

function normalizeTenantAIConfig(raw: Record<string, unknown>): TenantAIConfigPublic {
  return {
    is_active: Boolean(raw.is_active),
    custom_model_id:
      raw.custom_model_id === null || raw.custom_model_id === undefined
        ? null
        : String(raw.custom_model_id),
    feedback_count: Number(raw.feedback_count ?? 0),
  };
}

export async function fetchTenantAIConfigPublic(): Promise<TenantAIConfigPublic> {
  const { data } = await api.get<ApiResponse<Record<string, unknown>>>('/ai-config');
  if (!data.data || typeof data.data !== 'object') {
    throw new Error('Invalid AI config response');
  }
  return normalizeTenantAIConfig(data.data);
}
