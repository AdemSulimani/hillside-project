import axios from 'axios';
import { useAuthStore } from '@/store/authStore';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:8000/api',
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Default Content-Type is application/json; FormData must use multipart with a boundary.
  if (config.data instanceof FormData) {
    delete config.headers['Content-Type'];
  }
  return config;
});

let isRefreshing = false;
let pendingRequests: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function onRefreshSuccess(newToken: string) {
  pendingRequests.forEach((p) => p.resolve(newToken));
  pendingRequests = [];
}

function onRefreshFailure(err: unknown) {
  pendingRequests.forEach((p) => p.reject(err));
  pendingRequests = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    const skipRefresh =
      originalRequest?.url?.includes('/auth/refresh') ||
      originalRequest?.url?.includes('/auth/login') ||
      originalRequest?.url?.includes('/auth/register') ||
      originalRequest?._skipAuthRefresh;

    if (error.response?.status !== 401 || skipRefresh || originalRequest._retry) {
      return Promise.reject(error);
    }

    originalRequest._retry = true;

    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        pendingRequests.push({
          resolve: (token: string) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            resolve(api(originalRequest));
          },
          reject,
        });
      });
    }

    isRefreshing = true;

    try {
      const { data } = await api.post('/auth/refresh');
      const newToken = data.data.accessToken as string;

      useAuthStore.getState().setAccessToken(newToken);
      originalRequest.headers.Authorization = `Bearer ${newToken}`;

      onRefreshSuccess(newToken);
      return api(originalRequest);
    } catch (refreshError) {
      onRefreshFailure(refreshError);
      useAuthStore.getState().clearAuth();
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  },
);

export default api;
