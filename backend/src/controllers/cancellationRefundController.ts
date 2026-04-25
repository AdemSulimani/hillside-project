import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  findOrderByIdForTenant,
  listActionRequiredOrdersForTenant,
  resolveOrderActionForTenant,
} from '../db/models/order';
import { findConversationByIdForTenant, setConversationAiPaused } from '../db/models/conversation';
import { findChannelById } from '../db/models/channel';
import { findContactById } from '../db/models/contact';
import { createMessage } from '../db/models/message';
import { sendMessage } from '../services/channelSenderService';
import { socketService } from '../services/socketService';
import { sendError, sendSuccess } from '../utils/response';
import type {
  ResolveOrderActionBody,
  SendResolutionMessageBody,
} from '../validators/order';

export async function listActionRequired(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const orders = await listActionRequiredOrdersForTenant(tenantId);
    sendSuccess(res, { orders }, 'Action-required orders retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve action-required orders', 500, err);
  }
}

export async function resolve(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { orderId } = (req.validated?.params ?? req.params) as { orderId: string };
    const body = (req.validated?.body ?? req.body) as ResolveOrderActionBody;

    const existing = await findOrderByIdForTenant(orderId, tenantId);
    if (!existing) {
      sendError(res, 'Order not found', 404);
      return;
    }

    const updated = await resolveOrderActionForTenant(orderId, tenantId, {
      resolution_status: body.resolution_status,
      resolution_notes: body.resolution_notes,
    });
    if (!updated) {
      sendError(res, 'Failed to resolve order action', 500);
      return;
    }

    if (body.resume_ai === true) {
      await setConversationAiPaused(existing.conversation_id, tenantId, false);
      socketService.emitConversationUpdated(tenantId, existing.conversation_id);
    }

    sendSuccess(
      res,
      { order: updated, resume_ai: body.resume_ai === true },
      'Order action resolved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to resolve order action', 500, err);
  }
}

export async function sendResolutionMessage(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { orderId } = (req.validated?.params ?? req.params) as { orderId: string };
    const body = (req.validated?.body ?? req.body) as SendResolutionMessageBody;

    const order = await findOrderByIdForTenant(orderId, tenantId);
    if (!order) {
      sendError(res, 'Order not found', 404);
      return;
    }

    const conversation = await findConversationByIdForTenant(order.conversation_id, tenantId);
    if (!conversation) {
      sendError(res, 'Conversation not found', 404);
      return;
    }

    const [channel, contact] = await Promise.all([
      findChannelById(conversation.channel_id, tenantId),
      findContactById(conversation.contact_id),
    ]);
    if (!channel || !contact || contact.tenant_id !== tenantId) {
      sendError(res, 'Channel or contact not found', 404);
      return;
    }

    const sendResult = await sendMessage(channel, contact.external_id, body.message);
    const outbound = await createMessage({
      tenant_id: tenantId,
      conversation_id: conversation.id,
      external_message_id: sendResult.graphMessageId ?? `human_${randomUUID()}`,
      direction: 'outbound',
      type: 'text',
      content: body.message,
      sent_by: 'human',
    });

    socketService.emitNewMessage(tenantId, outbound);
    socketService.emitConversationUpdated(tenantId, conversation.id);

    if (!sendResult.success) {
      sendError(res, 'Resolution message saved but failed to send on channel', 502, {
        message: outbound,
        error: sendResult.error ?? 'Unknown channel send failure',
      });
      return;
    }

    sendSuccess(res, { message: outbound }, 'Resolution message sent successfully', 201);
  } catch (err) {
    sendError(res, 'Failed to send resolution message', 500, err);
  }
}
