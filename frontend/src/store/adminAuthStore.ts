import { create } from 'zustand';

const STORAGE_KEY = 'hillside_admin_auth';

function readStored(): { accessToken: string | null; owner: { id: string; email: string } | null } {
  if (typeof window === 'undefined') {
    return { accessToken: null, owner: null };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { accessToken: null, owner: null };
    const parsed = JSON.parse(raw) as { accessToken?: string; owner?: { id: string; email: string } };
    if (!parsed.accessToken) return { accessToken: null, owner: null };
    return {
      accessToken: parsed.accessToken,
      owner: parsed.owner ?? null,
    };
  } catch {
    return { accessToken: null, owner: null };
  }
}

const initial = readStored();

interface AdminAuthState {
  accessToken: string | null;
  owner: { id: string; email: string } | null;
  isAuthenticated: boolean;
  setAuth: (accessToken: string, owner: { id: string; email: string }) => void;
  clearAuth: () => void;
}

export const useAdminAuthStore = create<AdminAuthState>((set) => ({
  accessToken: initial.accessToken,
  owner: initial.owner,
  isAuthenticated: Boolean(initial.accessToken),
  setAuth: (accessToken, owner) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken, owner }));
    set({ accessToken, owner, isAuthenticated: true });
  },
  clearAuth: () => {
    localStorage.removeItem(STORAGE_KEY);
    set({ accessToken: null, owner: null, isAuthenticated: false });
  },
}));
