import api from '@/lib/api';
import type { ApiResponse } from '@/types';
import type { StatisticsSummary } from '@/types/statistics';

function assertSummary(raw: unknown): StatisticsSummary {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid statistics response');
  }
  return raw as StatisticsSummary;
}

export async function fetchStatisticsSummary(params: {
  startDate: string;
  endDate: string;
}): Promise<StatisticsSummary> {
  const { data } = await api.get<ApiResponse<StatisticsSummary>>('/statistics/summary', {
    params: {
      startDate: params.startDate,
      endDate: params.endDate,
    },
  });
  if (!data.success || data.data === undefined) {
    throw new Error(data.message || 'Failed to load statistics');
  }
  return assertSummary(data.data);
}
