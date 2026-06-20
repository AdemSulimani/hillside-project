import axios from 'axios';
import { useAdminAuthStore } from '@/store/adminAuthStore';

const adminApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

adminApi.interceptors.request.use((config) => {
  const token = useAdminAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

adminApi.interceptors.response.use(
  (response) => response,
  (error) => {
    const isLoginRequest = (error.config?.url as string | undefined)?.includes('/admin/auth/login');
    if (!isLoginRequest && (error.response?.status === 401 || error.response?.status === 403)) {
      useAdminAuthStore.getState().clearAuth();
      window.location.replace('/admin/login');
    }
    return Promise.reject(error);
  },
);

export default adminApi;
