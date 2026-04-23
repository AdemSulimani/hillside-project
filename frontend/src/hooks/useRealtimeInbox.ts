import { useEffect, useLayoutEffect, useRef } from 'react';
import {
  type InfiniteData,
  type QueryClient,
  useQueryClient,
} from '@tanstack/react-query';
import { normalizeInboxMessage } from '@/api/conversationsApi';
import { useCrmSocket } from '@/contexts/CrmSocketContext';
import type {
  ConversationSummary,
  ConversationThread,
  ConversationsListResult,
} from '@/types/conversation';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseNewMessagePayload(payload: unknown): {
  conversationId: string;
  message: Record<string, unknown>;
} | null {
  if (!isRecord(payload)) return null;
  const conversationId = payload.conversationId;
  const message = payload.message;
  if (typeof conversationId !== 'string' || !isRecord(message)) return null;
  return { conversationId, message };
}

function parseConversationUpdatedPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const id = payload.conversationId;
  return typeof id === 'string' ? id : null;
}

function parseMessageSendFailedPayload(payload: unknown): {
  messageId: string;
  conversationId: string;
  error: string;
} | null {
  if (!isRecord(payload)) return null;
  const messageId = payload.messageId;
  const conversationId = payload.conversationId;
  const error = payload.error;
  if (typeof messageId !== 'string' || typeof conversationId !== 'string') return null;
  return {
    messageId,
    conversationId,
    error: typeof error === 'string' ? error : 'Send failed',
  };
}

/**
 * Applies list-row updates for a conversation across all cached inbox list queries
 * (every channel/status infinite-query variant). Returns whether the row existed in cache.
 */
function patchConversationSummaries(
  queryClient: QueryClient,
  conversationId: string,
  updater: (row: ConversationSummary) => ConversationSummary,
): boolean {
  let found = false;
  queryClient.setQueriesData<InfiniteData<ConversationsListResult>>(
    { queryKey: ['conversations', 'list'], exact: false },
    (old) => {
      if (!old?.pages) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          conversations: page.conversations.map((c) => {
            if (c.id !== conversationId) return c;
            found = true;
            return updater(c);
          }),
        })),
      };
    },
  );
  return found;
}

/**
 * Subscribes to inbox Socket.io events: updates the open thread cache, list previews / unread
 * cues, refetches the conversation list when the server signals an update, and refreshes the
 * global unread count for inbound traffic.
 */
export function useRealtimeInbox(selectedConversationId: string | null): void {
  const queryClient = useQueryClient();
  const socket = useCrmSocket();
  const selectedRef = useRef(selectedConversationId);

  useLayoutEffect(() => {
    selectedRef.current = selectedConversationId;
  }, [selectedConversationId]);

  useEffect(() => {
    if (!socket) return;

    const onConnectError = (err: Error) => {
      console.warn('[realtime inbox] connection error:', err.message);
    };

    const onNewMessage = (payload: unknown) => {
      const parsed = parseNewMessagePayload(payload);
      if (!parsed) return;

      const inboxMessage = normalizeInboxMessage(parsed.message);
      const { conversationId } = parsed;
      const activeId = selectedRef.current;

      if (conversationId === activeId) {
        queryClient.setQueryData<ConversationThread>(
          ['conversations', conversationId, 'detail'],
          (old) => {
            if (!old) return old;
            if (old.messages.some((m) => m.id === inboxMessage.id)) return old;
            // Outbound echo from the server: drop our optimistic bubble so we do not show two sends.
            const base =
              inboxMessage.direction === 'outbound'
                ? old.messages.filter(
                    (m) =>
                      !(
                        String(m.id).startsWith('optimistic-') &&
                        m.direction === 'outbound'
                      ),
                  )
                : old.messages;
            if (base.some((m) => m.id === inboxMessage.id)) return old;
            return {
              ...old,
              conversation: {
                ...old.conversation,
                last_message_at: inboxMessage.created_at,
              },
              messages: [...base, inboxMessage],
            };
          },
        );
        return;
      }

      const preview =
        inboxMessage.content?.trim() ||
        (inboxMessage.type !== 'text' ? `(${inboxMessage.type})` : '(No text)');

      const found = patchConversationSummaries(queryClient, conversationId, (row) => ({
        ...row,
        last_message_at: inboxMessage.created_at,
        last_message_content: preview,
        last_message_created_at: inboxMessage.created_at,
        has_outbound_message:
          inboxMessage.direction === 'outbound' ? true : row.has_outbound_message,
      }));

      if (!found) {
        void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
      }

      if (inboxMessage.direction === 'inbound') {
        void queryClient.invalidateQueries({ queryKey: ['conversations', 'unread-count'] });
      }
    };

    const onConversationUpdated = (payload: unknown) => {
      const conversationId = parseConversationUpdatedPayload(payload);
      if (!conversationId) return;
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'unread-count'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', conversationId, 'detail'] });
    };

    const onMessageSendFailed = (payload: unknown) => {
      const parsed = parseMessageSendFailedPayload(payload);
      if (!parsed) return;
      const { messageId, conversationId, error } = parsed;
      const activeId = selectedRef.current;
      if (conversationId !== activeId) return;

      queryClient.setQueryData<ConversationThread>(
        ['conversations', conversationId, 'detail'],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            messages: old.messages.map((m) =>
              m.id === messageId ? { ...m, send_status: 'failed', send_error: error } : m,
            ),
          };
        },
      );
    };

    socket.on('connect_error', onConnectError);
    socket.on('new_message', onNewMessage);
    socket.on('conversation_updated', onConversationUpdated);
    socket.on('message_send_failed', onMessageSendFailed);

    return () => {
      socket.off('connect_error', onConnectError);
      socket.off('new_message', onNewMessage);
      socket.off('conversation_updated', onConversationUpdated);
      socket.off('message_send_failed', onMessageSendFailed);
    };
  }, [socket, queryClient]);
}
