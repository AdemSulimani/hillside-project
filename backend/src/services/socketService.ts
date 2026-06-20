import type { Server } from 'socket.io';
import type { Message } from '../db/models/message';
import type { MessageReplyToPayload } from './conversationService';
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

  /**
   * Emits the new message to the tenant room. Pass `replyTo` when the message references
   * another row (thread reply) so clients can render the quote without refetching.
   */
  emitNewMessage(tenantId: string, message: Message, replyTo?: MessageReplyToPayload): void {
    if (!io) return;
    const messagePayload =
      replyTo !== undefined ? { ...message, replyTo } : message;
    io.to(tenantRoom(tenantId)).emit('new_message', {
      message: messagePayload,
      conversationId: message.conversation_id,
    });
  },

  emitConversationUpdated(tenantId: string, conversationId: string): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('conversation_updated', { conversationId });
  },

  /**
   * Broadcasts an in-place edit on an existing message (Meta `message_edits` etc.). Clients
   * should patch the matching row in the open thread without inserting a new bubble. Pass the
   * fully-mapped `Message` row so the client receives the updated edit metadata.
   */
  emitMessageEdited(tenantId: string, message: Message): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('message_edited', {
      message,
      conversationId: message.conversation_id,
    });
  },

  emitOrderCreated(tenantId: string, order: Order): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('order_created', { order });
  },

  /**
   * Emitted when the AI updates an existing order's customer information
   * (address, phone, name, or notes) in response to a customer correction request.
   * Clients should patch the matching order row in any open order list or detail view.
   */
  emitOrderUpdated(tenantId: string, order: Order): void {
    if (!io) return;
    io.to(tenantRoom(tenantId)).emit('order_updated', { order });
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
