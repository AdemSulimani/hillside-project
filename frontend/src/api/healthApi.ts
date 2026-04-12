import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { QueuesHealthPayload } from '@/types/queueHealth';

export async function fetchQueuesHealth(): Promise<QueuesHealthPayload> {
  const { data } = await api.get<ApiResponse<QueuesHealthPayload>>('/health/queues');
  if (!data.success || data.data === undefined) {
    throw new Error(data.message || 'Failed to load queue health');
  }
  return data.data;
}
