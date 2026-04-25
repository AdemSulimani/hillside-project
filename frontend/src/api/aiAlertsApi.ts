import api from '@/lib/api';
import type { ApiResponse, PaginatedResponse } from '@/types';
import type { AIAlertRow, AIAlertStatus } from '@/types/aiAlert';
import type { ChannelType } from '@/types/conversation';

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return Boolean(v);
}

function normalizeAIAlertRow(raw: Record<string, unknown>): AIAlertRow {
  const qs = raw.quality_score;
  let quality_score: number | null = null;
  if (qs != null && qs !== '') {
    const n = Number(qs);
    quality_score = Number.isFinite(n) ? n : null;
  }
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    conversation_id: raw.conversation_id != null ? String(raw.conversation_id) : null,
    message_id: raw.message_id != null ? String(raw.message_id) : null,
    reason: String(raw.reason ?? ''),
    status: (raw.status as AIAlertStatus) ?? 'unread',
    created_at: String(raw.created_at ?? ''),
    contact_name: String(raw.contact_name ?? ''),
    channel_type: (raw.channel_type as ChannelType) ?? 'facebook',
    channel_name: String(raw.channel_name ?? ''),
    message_content: raw.message_content != null ? String(raw.message_content) : null,
    quality_score,
    customer_question:
      raw.customer_question != null
        ? String(raw.customer_question)
        : raw.inbound_message != null
          ? String(raw.inbound_message)
          : raw.message_content != null
            ? String(raw.message_content)
            : null,
    product_id:
      raw.product_id != null
        ? String(raw.product_id)
        : raw.related_product_id != null
          ? String(raw.related_product_id)
          : null,
    product_name:
      raw.product_name != null
        ? String(raw.product_name)
        : raw.related_product_name != null
          ? String(raw.related_product_name)
          : null,
    usage_description:
      raw.usage_description != null
        ? String(raw.usage_description)
        : raw.product_usage_description != null
          ? String(raw.product_usage_description)
          : null,
  };
}

export async function fetchAIAlertsUnreadCount(): Promise<number> {
  const { data } = await api.get<ApiResponse<{ count: number }>>('/ai-alerts/unread-count');
  return Number(data.data?.count ?? 0);
}

export type AIAlertsListParams = {
  page?: number;
  limit?: number;
  status?: AIAlertStatus;
};

export async function fetchAIAlerts(params: AIAlertsListParams = {}): Promise<{
  alerts: AIAlertRow[];
  pagination: PaginatedResponse<AIAlertRow>['pagination'];
}> {
  const { data } = await api.get<
    ApiResponse<Record<string, unknown>[]> & {
      pagination?: PaginatedResponse<unknown>['pagination'];
    }
  >('/ai-alerts', {
    params: {
      page: params.page ?? 1,
      limit: params.limit ?? 20,
      status: params.status,
    },
  });

  const rows = (data.data ?? []) as Record<string, unknown>[];
  const pagination = data.pagination ?? {
    page: params.page ?? 1,
    limit: params.limit ?? 20,
    total: 0,
    totalPages: 0,
  };
  return {
    alerts: rows.map((r) => normalizeAIAlertRow(r)),
    pagination,
  };
}

export async function fetchUsageEscalations(params: Omit<AIAlertsListParams, 'status'> = {}): Promise<{
  alerts: AIAlertRow[];
  pagination: PaginatedResponse<AIAlertRow>['pagination'];
}> {
  const { data } = await api.get<
    ApiResponse<Record<string, unknown>[]> & {
      pagination?: PaginatedResponse<unknown>['pagination'];
    }
  >('/escalations', {
    params: {
      page: params.page ?? 1,
      limit: params.limit ?? 20,
    },
  });

  const rows = (data.data ?? []) as Record<string, unknown>[];
  const pagination = data.pagination ?? {
    page: params.page ?? 1,
    limit: params.limit ?? 20,
    total: 0,
    totalPages: 0,
  };
  return {
    alerts: rows.map((r) => normalizeAIAlertRow(r)),
    pagination,
  };
}

export async function markAIAlertRead(alertId: string): Promise<void> {
  await api.patch(`/ai-alerts/${alertId}/read`);
}

export async function markAllAIAlertsRead(): Promise<number> {
  const { data } = await api.post<ApiResponse<{ updated: number }>>(
    '/ai-alerts/mark-all-read',
    {},
  );
  return Number(data.data?.updated ?? 0);
}

export type ResolveAIAlertParams = {
  resume_ai?: boolean;
};

export async function resolveAIAlert(
  alertId: string,
  params: ResolveAIAlertParams = {},
): Promise<{ resume_ai: boolean }> {
  const { data } = await api.patch<ApiResponse<{ resume_ai?: boolean }>>(
    `/ai-alerts/${alertId}/resolve`,
    { resume_ai: params.resume_ai === true },
  );
  return { resume_ai: toBool(data.data?.resume_ai) };
}
