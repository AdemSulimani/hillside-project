import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCrmSocket } from '@/contexts/CrmSocketContext';
import type { ActionRequiredOrder } from '@/types/order';
import { normalizeActionRequiredOrder } from '@/api/ordersApi';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parsePayload(raw: unknown): { order: ActionRequiredOrder; reason: string | null } | null {
  if (!isRecord(raw)) return null;
  const orderRaw = raw.order;
  if (!isRecord(orderRaw)) return null;
  return {
    order: normalizeActionRequiredOrder(orderRaw),
    reason: typeof raw.reason === 'string' ? raw.reason : null,
  };
}

function actionTypeFromOrder(order: ActionRequiredOrder): 'cancellation' | 'refund' {
  const cancellationAt = order.cancellation_requested_at
    ? new Date(order.cancellation_requested_at).getTime()
    : null;
  const refundAt = order.refund_requested_at ? new Date(order.refund_requested_at).getTime() : null;
  if (refundAt !== null && (cancellationAt === null || refundAt >= cancellationAt)) {
    return 'refund';
  }
  return 'cancellation';
}

export function useOrderActionRequiredToast(): void {
  const socket = useCrmSocket();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (!socket) return;

    const onOrderActionRequired = (raw: unknown) => {
      const parsed = parsePayload(raw);
      if (!parsed) return;

      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'unread-count'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'list'] });

      const kind = actionTypeFromOrder(parsed.order);
      const toastId = toast.error(
        `Customer requested ${kind} for order #${parsed.order.id.slice(0, 8)} — ${parsed.order.customer_name}`,
        {
          duration: Infinity,
          dismissible: false,
          closeButton: true,
          action: {
            label: 'View Request',
            onClick: () => {
              navigate('/orders?tab=action_required');
              toast.dismiss(toastId);
            },
          },
          cancel: {
            label: 'Dismiss',
            onClick: () => toast.dismiss(toastId),
          },
        },
      );
    };

    socket.on('order_action_required', onOrderActionRequired);
    return () => {
      socket.off('order_action_required', onOrderActionRequired);
    };
  }, [socket, queryClient, navigate]);
}
