import { create } from 'zustand';

interface AppState {
  sidebarOpen: boolean;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  /** New orders since last visit to /orders; driven by realtime `order_created`. */
  ordersNavNewCount: number;
  incrementOrdersNavNewCount: () => void;
  resetOrdersNavNewCount: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  ordersNavNewCount: 0,
  incrementOrdersNavNewCount: () => set((s) => ({ ordersNavNewCount: s.ordersNavNewCount + 1 })),
  resetOrdersNavNewCount: () => set({ ordersNavNewCount: 0 }),
}));
