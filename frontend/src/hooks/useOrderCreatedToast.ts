import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCrmSocket } from '@/contexts/CrmSocketContext';
import { useAppStore } from '@/store/app';

function parseOrderCreatedCustomerName(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const order = (payload as Record<string, unknown>).order;
  if (!order || typeof order !== 'object') return null;
  const name = (order as Record<string, unknown>).customer_name;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/**
 * Listens for `order_created` on the shared CRM socket and surfaces a toast plus cache invalidation.
 */
export function useOrderCreatedToast(): void {
  const socket = useCrmSocket();
  const queryClient = useQueryClient();
  const location = useLocation();
  const incrementOrdersNavNewCount = useAppStore((s) => s.incrementOrdersNavNewCount);

  useEffect(() => {
    if (!socket) return;

    const onOrderCreated = (payload: unknown) => {
      const name = parseOrderCreatedCustomerName(payload);
      const label = name ?? 'një klient';
      toast.success(`Porosi e re skicë për ${label}`);
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'draft-for-conversation'] });
      if (!location.pathname.startsWith('/orders')) {
        incrementOrdersNavNewCount();
      }
    };

    socket.on('order_created', onOrderCreated);
    return () => {
      socket.off('order_created', onOrderCreated);
    };
  }, [socket, queryClient, location.pathname, incrementOrdersNavNewCount]);
}
