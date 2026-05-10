import api from '@/lib/api';
import { queryClient } from '@/lib/query-client';
import { clearPerRouteLazyRetryFlags } from '@/lib/hardReload';
import { useAuthStore } from '@/store/authStore';
import type { ApiResponse, Tenant, User } from '@/types';

/**
 * Single-flight session restore. React StrictMode runs effects twice in dev; without this,
 * two parallel POST /auth/refresh calls race: the first rotates the token and the second
 * gets 401, so the user appears logged out after refresh.
 */
let inFlight: Promise<boolean> | null = null;

export function restoreSessionOnce(): Promise<boolean> {
  if (inFlight) return inFlight;

  const run = (async (): Promise<boolean> => {
    try {
      const { data: refreshData } = await api.post<ApiResponse<{ accessToken: string }>>(
        '/auth/refresh',
      );
      const accessToken = refreshData.data?.accessToken;

      if (!accessToken) return false;

      useAuthStore.getState().setAccessToken(accessToken);

      const { data } = await api.get<ApiResponse<{ user: User }>>('/auth/me', {
        _skipAuthRefresh: true,
      } as never);

      if (!data.data?.user) return false;

      queryClient.clear();
      useAuthStore.getState().setAuth(data.data.user, accessToken);

      try {
        const { data: statusData } = await api.get<ApiResponse<{ completed: boolean }>>(
          '/onboarding/status',
        );
        const completed = statusData.data?.completed ?? false;
        useAuthStore.getState().setOnboarded(completed);

        if (completed) {
          try {
            const { data: bizData } = await api.get<ApiResponse<{ business: Tenant }>>(
              '/business',
            );
            if (bizData.data?.business) {
              useAuthStore.getState().setTenant(bizData.data.business);
            }
          } catch {
            // Tenant fetch failed — header will use fallback values
          }
        }
      } catch {
        // Onboarding status check failed — default to not onboarded
      }

      // Drop stale chunk-retry flags from an older deploy/tab so first sidebar navigation works.
      clearPerRouteLazyRetryFlags();

      return true;
    } catch {
      return false;
    }
  })();

  inFlight = run.finally(() => {
    inFlight = null;
  });

  return inFlight;
}
