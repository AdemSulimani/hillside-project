import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { queryClient } from '@/lib/query-client';
import api from '@/lib/api';
import { clearPerRouteLazyRetryFlags } from '@/lib/hardReload';
import type { User, Tenant, ApiResponse } from '@/types';

interface AuthResponse {
  user: User;
  accessToken: string;
}

async function fetchOnboardingStatus(): Promise<boolean> {
  try {
    const { data } = await api.get<ApiResponse<{ completed: boolean }>>('/onboarding/status');
    return data.data?.completed ?? false;
  } catch {
    return false;
  }
}

export function useAuth() {
  const { user, isAuthenticated, setAuth, clearAuth } = useAuthStore();
  const navigate = useNavigate();

  const register = useCallback(
    async (name: string, email: string, password: string, rememberMe = false) => {
      const { data } = await api.post<ApiResponse<AuthResponse>>('/auth/register', {
        name,
        email,
        password,
        rememberMe,
      });
      const { user: newUser, accessToken } = data.data!;
      queryClient.clear();
      setAuth(newUser, accessToken);
      clearPerRouteLazyRetryFlags();
      useAuthStore.getState().setOnboarded(false);
      navigate('/onboarding');
    },
    [setAuth, navigate],
  );

  const login = useCallback(
    async (email: string, password: string, rememberMe = false) => {
      const { data } = await api.post<ApiResponse<AuthResponse>>('/auth/login', {
        email,
        password,
        rememberMe,
      });
      const { user: loggedInUser, accessToken } = data.data!;
      queryClient.clear();
      setAuth(loggedInUser, accessToken);
      clearPerRouteLazyRetryFlags();

      const completed = await fetchOnboardingStatus();
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

      navigate(completed ? '/dashboard' : '/onboarding');
    },
    [setAuth, navigate],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      queryClient.clear();
      clearAuth();
      clearPerRouteLazyRetryFlags();
      navigate('/login');
    }
  }, [clearAuth, navigate]);

  return { user, isAuthenticated, register, login, logout };
}
