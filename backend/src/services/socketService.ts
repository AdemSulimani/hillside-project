import type { Server } from 'socket.io';
import type { Message } from '../db/models/message';
import type { Order } from '../db/models/order';
import type { AIAlert } from '../db/models/aiAlert';
import type { ChannelType } from '../db/models/channel';

/** Payload for real-time owner notifications when an AI reply fails quality checks. */
export type AIAlertSocketPayload = AIAlert & {
  message_content: string | null;
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
};

let io: Server | null = null;

function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export const socketService = {
  attach(serverIo: Server): void {
    io = serverIo;
  },

  emitNewMessage(tenantId: string, message: Message): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('new_message', {
      message,
      conversationId: message.conversation_id,
    });
  },

  emitConversationUpdated(tenantId: string, conversationId: string): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('conversation_updated', { conversationId });
  },

  emitOrderCreated(tenantId: string, order: Order): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('order_created', { order });
  },

  emitOrderActionRequired(
    tenantId: string,
    payload: { order: Order; reason: string | null },
  ): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('order_action_required', payload);
  },

  emitAIAlert(tenantId: string, alert: AIAlertSocketPayload): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('ai_alert', alert);
  },

  emitMessageSendFailed(
    tenantId: string,
    payload: { messageId: string; conversationId: string; error: string },
  ): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('message_send_failed', payload);
  },
};
