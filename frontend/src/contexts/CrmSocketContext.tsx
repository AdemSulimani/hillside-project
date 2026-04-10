import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { createInboxSocket } from '@/lib/socket';
import { useAuthStore } from '@/store/authStore';

const CrmSocketContext = createContext<Socket | null>(null);

export function CrmSocketProvider({ children }: { children: ReactNode }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!isAuthenticated || !accessToken) {
      setSocket(null);
      return;
    }

    const s = createInboxSocket(accessToken);
    s.connect();
    setSocket(s);

    return () => {
      s.disconnect();
      setSocket(null);
    };
  }, [accessToken, isAuthenticated]);

  return <CrmSocketContext.Provider value={socket}>{children}</CrmSocketContext.Provider>;
}

export function useCrmSocket(): Socket | null {
  return useContext(CrmSocketContext);
}
