import { create } from 'zustand';
import type { User, Tenant } from '@/types';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  isAuthenticated: boolean;
  tenant: Tenant | null;
  isOnboarded: boolean;
  setAuth: (user: User, accessToken: string) => void;
  setAccessToken: (accessToken: string) => void;
  setOnboarded: (value: boolean) => void;
  setTenant: (tenant: Tenant) => void;
  setUser: (user: User) => void;
  clearAuth: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: null,
  isAuthenticated: false,
  tenant: null,
  isOnboarded: false,
  setAuth: (user, accessToken) => set({ user, accessToken, isAuthenticated: true }),
  setAccessToken: (accessToken) => set({ accessToken }),
  setOnboarded: (value) => set({ isOnboarded: value }),
  setTenant: (tenant) => set({ tenant }),
  setUser: (user) => set({ user }),
  clearAuth: () => set({
    user: null,
    accessToken: null,
    isAuthenticated: false,
    tenant: null,
    isOnboarded: false,
  }),
}));
