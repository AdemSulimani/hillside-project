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
    (conversation_id !== null && conversation_id !== undefined && typeof conversation_id !== 'string') ||
    (message_id !== null && message_id !== undefined && typeof message_id !== 'string') ||
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
  const contact_name = typeof raw.contact_name === 'string' ? raw.contact_name : 'Klienti';
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
    conversation_id: conversation_id != null ? String(conversation_id) : null,
    message_id: message_id != null ? String(message_id) : null,
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

function getAlertToastDescription(reason: string): string {
  if (reason === 'post_purchase_support_request') {
    return 'Klienti ka problem me dërgesën ose produktin. Ju lutemi shqyrtoni dhe përgjigjuni manualisht.';
  }
  if (reason === 'cancellation_request' || reason === 'refund_request') {
    return 'Klienti kërkoi një veprim për porosinë. Hapni Porositë > Veprim i nevojshëm.';
  }
  if (reason === 'usage_question_unanswered') {
    return 'IA nuk mundi të përgjigjej për përdorimin e produktit. Ju lutemi ndërhyjni manualisht.';
  }
  return 'Shqyrtoni bisedën dhe vendosni nëse merrni kontrollin ose rifilloni chatbot-in.';
}

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
      const title = `IA kërkon vëmendje — biseda me ${payload.contact_name} në ${channelLabel}`;

      const tid = toast.warning(title, {
        duration: Infinity,
        dismissible: false,
        closeButton: true,
        icon: warningIcon,
        description: getAlertToastDescription(payload.reason),
        action: {
          label: 'Shiko bisedën',
          onClick: () => {
            if (payload.reason === 'cancellation_request' || payload.reason === 'refund_request') {
              navigate('/orders?tab=action_required');
            } else if (payload.conversation_id) {
              navigate(`/inbox?c=${payload.conversation_id}`);
            }
            toast.dismiss(tid);
          },
        },
        cancel: {
          label: 'Mbyll',
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
