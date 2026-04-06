import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import api from '@/lib/api';
import { Spinner } from '@/components/ui/spinner';
import App from './App';
import type { User, ApiResponse } from '@/types';

export default function AppWithSessionRestore() {
  const [loading, setLoading] = useState(true);
  const setAuth = useAuthStore((s) => s.setAuth);

  useEffect(() => {
    let cancelled = false;

    async function restoreSession() {
      try {
        const { data: refreshData } = await api.post<ApiResponse<{ accessToken: string }>>(
          '/auth/refresh',
        );
        const accessToken = refreshData.data?.accessToken;

        if (accessToken) {
          useAuthStore.getState().setAccessToken(accessToken);

          const { data } = await api.get<ApiResponse<{ user: User }>>('/auth/me', {
            _skipAuthRefresh: true,
          } as never);
          if (!cancelled && data.data?.user) {
            setAuth(data.data.user, accessToken);
          }
        }
      } catch {
        // No valid session — user will see login page
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    restoreSession();
    return () => { cancelled = true; };
  }, [setAuth]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="size-8" />
      </div>
    );
  }

  return <App />;
}
