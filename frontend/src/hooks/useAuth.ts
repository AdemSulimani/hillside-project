import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import api from '@/lib/api';
import type { User, ApiResponse } from '@/types';

interface AuthResponse {
  user: User;
  accessToken: string;
}

export function useAuth() {
  const { user, isAuthenticated, setAuth, clearAuth } = useAuthStore();
  const navigate = useNavigate();

  const register = useCallback(
    async (name: string, email: string, password: string) => {
      const { data } = await api.post<ApiResponse<AuthResponse>>('/auth/register', {
        name,
        email,
        password,
      });
      const { user: newUser, accessToken } = data.data!;
      setAuth(newUser, accessToken);
      navigate('/onboarding');
    },
    [setAuth, navigate],
  );

  const login = useCallback(
    async (email: string, password: string) => {
      const { data } = await api.post<ApiResponse<AuthResponse>>('/auth/login', {
        email,
        password,
      });
      const { user: loggedInUser, accessToken } = data.data!;
      setAuth(loggedInUser, accessToken);
      navigate('/dashboard');
    },
    [setAuth, navigate],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } finally {
      clearAuth();
      navigate('/login');
    }
  }, [clearAuth, navigate]);

  return { user, isAuthenticated, register, login, logout };
}
