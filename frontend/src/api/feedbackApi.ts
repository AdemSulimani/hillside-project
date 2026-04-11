import api from '@/lib/api';
import type { PaginatedResponse } from '@/types';
import type { FeedbackLog, FeedbackLogStatus } from '@/types/feedback';

type FeedbackListJson = {
  success: boolean;
  data: Record<string, unknown>[];
  pagination: PaginatedResponse<unknown>['pagination'];
  message?: string;
};

function normalizeFeedbackLog(raw: Record<string, unknown>): FeedbackLog {
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    message_id: String(raw.message_id),
    conversation_id: String(raw.conversation_id),
    original_ai_response: String(raw.original_ai_response ?? ''),
    corrected_response:
      raw.corrected_response === null || raw.corrected_response === undefined
        ? null
        : String(raw.corrected_response),
    reason: raw.reason === null || raw.reason === undefined ? null : String(raw.reason),
    status: (raw.status as FeedbackLogStatus) ?? 'pending',
    created_at: String(raw.created_at ?? ''),
  };
}

export type SubmitFeedbackPayload = {
  message_id: string;
  corrected_response: string;
  reason: string;
};

export async function submitFeedback(payload: SubmitFeedbackPayload): Promise<void> {
  await api.post('/feedback', payload);
}

export type FeedbackListParams = {
  page?: number;
  limit?: number;
  status?: FeedbackLogStatus;
};

export async function fetchFeedbackLogs(params: FeedbackListParams): Promise<{
  logs: FeedbackLog[];
  pagination: PaginatedResponse<FeedbackLog>['pagination'];
}> {
  const { data } = await api.get<FeedbackListJson>('/feedback', {
    params: {
      page: params.page ?? 1,
      limit: params.limit ?? 20,
      status: params.status,
    },
  });

  const logs = (data.data ?? []).map((row) => normalizeFeedbackLog(row));
  const pagination = data.pagination ?? {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 0,
  };

  return { logs, pagination };
}
