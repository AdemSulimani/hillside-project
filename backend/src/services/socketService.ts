import type { Server } from 'socket.io';
import type { Message } from '../db/models/message';
import type { Order } from '../db/models/order';

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
};
