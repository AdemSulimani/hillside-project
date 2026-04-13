import { createElement, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { useCrmSocket } from '@/contexts/CrmSocketContext';
import type { AIAlertSocketPayload } from '@/types/aiAlert';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseAiAlertPayload(raw: unknown): AIAlertSocketPayload | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  const tenant_id = raw.tenant_id;
  const conversation_id = raw.conversation_id;
  const message_id = raw.message_id;
  const reason = raw.reason;
  const status = raw.status;
  const created_at = raw.created_at;
  if (
    typeof id !== 'string' ||
    typeof tenant_id !== 'string' ||
    typeof conversation_id !== 'string' ||
    typeof message_id !== 'string' ||
    typeof reason !== 'string' ||
    typeof status !== 'string' ||
    typeof created_at !== 'string'
  ) {
    return null;
  }
  const message_content =
    raw.message_content === null || raw.message_content === undefined
      ? null
      : String(raw.message_content);
  const contact_name = typeof raw.contact_name === 'string' ? raw.contact_name : 'Customer';
  const channel_type =
    raw.channel_type === 'facebook' ||
    raw.channel_type === 'instagram' ||
    raw.channel_type === 'whatsapp'
      ? raw.channel_type
      : 'facebook';
  const channel_name = typeof raw.channel_name === 'string' ? raw.channel_name : channel_type;

  return {
    id,
    tenant_id,
    conversation_id,
    message_id,
    reason,
    status: status as AIAlertSocketPayload['status'],
    created_at,
    message_content,
    contact_name,
    channel_type,
    channel_name,
  };
}

const warningIcon = createElement(AlertTriangle, {
  className: 'size-4 text-amber-600',
  'aria-hidden': true,
});

/**
 * App-wide listener for AI quality alerts: persistent toast + React Query invalidation.
 */
export function useAiAlertToast(): void {
  const socket = useCrmSocket();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  useEffect(() => {
    if (!socket) return;

    const onAiAlert = (raw: unknown) => {
      const payload = parseAiAlertPayload(raw);
      if (!payload) return;

      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'unread-count'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });

      const channelLabel = payload.channel_name.trim() || payload.channel_type;
      const title = `AI needs attention — ${payload.contact_name} conversation on ${channelLabel}`;

      const tid = toast.warning(title, {
        duration: Infinity,
        dismissible: false,
        closeButton: true,
        icon: warningIcon,
        description: 'Review the thread and decide whether to take over or resume the chatbot.',
        action: {
          label: 'View Conversation',
          onClick: () => {
            navigate(`/inbox?c=${payload.conversation_id}`);
            toast.dismiss(tid);
          },
        },
        cancel: {
          label: 'Dismiss',
          onClick: () => toast.dismiss(tid),
        },
      });
    };

    socket.on('ai_alert', onAiAlert);
    return () => {
      socket.off('ai_alert', onAiAlert);
    };
  }, [socket, queryClient, navigate]);
}
