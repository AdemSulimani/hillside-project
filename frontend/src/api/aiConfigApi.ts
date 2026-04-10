import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { AIConfig, AIConfigTestPayload, AIConfigUpdatePayload } from '@/types/aiConfig';

function normalizeAIConfig(raw: Record<string, unknown>): AIConfig {
  const restrictions = raw.restrictions;
  const qaPairs = raw.qa_pairs;

  return {
    id: String(raw.id ?? ''),
    tenant_id: String(raw.tenant_id ?? ''),
    tone: String(raw.tone ?? 'professional'),
    personality_description:
      raw.personality_description === null || raw.personality_description === undefined
        ? null
        : String(raw.personality_description),
    restrictions: Array.isArray(restrictions)
      ? restrictions.map((r) => String(r))
      : [],
    sales_strategy:
      raw.sales_strategy === null || raw.sales_strategy === undefined
        ? null
        : String(raw.sales_strategy),
    objection_handling:
      raw.objection_handling === null || raw.objection_handling === undefined
        ? null
        : String(raw.objection_handling),
    qa_pairs: Array.isArray(qaPairs)
      ? qaPairs.map((p) => {
          const row = p as Record<string, unknown>;
          return {
            question: String(row.question ?? ''),
            answer: String(row.answer ?? ''),
          };
        })
      : [],
    is_active: Boolean(raw.is_active),
    custom_model_id:
      raw.custom_model_id === null || raw.custom_model_id === undefined
        ? null
        : String(raw.custom_model_id),
    feedback_count: Number(raw.feedback_count ?? 0),
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
  };
}

export async function fetchAIConfig(): Promise<AIConfig> {
  const { data } = await api.get<ApiResponse<Record<string, unknown>>>('/ai-config');
  if (!data.data || typeof data.data !== 'object') {
    throw new Error('Invalid AI config response');
  }
  return normalizeAIConfig(data.data);
}

export async function updateAIConfig(payload: AIConfigUpdatePayload): Promise<AIConfig> {
  const { data } = await api.put<ApiResponse<Record<string, unknown>>>('/ai-config', payload);
  if (!data.data || typeof data.data !== 'object') {
    throw new Error('Invalid AI config response');
  }
  return normalizeAIConfig(data.data);
}

export async function testAIConfig(payload: AIConfigTestPayload): Promise<string> {
  const { data } = await api.post<ApiResponse<{ reply: string }>>('/ai-config/test', payload);
  const reply = data.data?.reply;
  if (typeof reply !== 'string') {
    throw new Error('Invalid test response');
  }
  return reply;
}
