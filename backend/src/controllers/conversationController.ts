import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { findChannelById } from '../db/models/channel';
import { createMessage, findMessageByExternalMessageId, type Message } from '../db/models/message';
import {
  updateConversationStatus,
  touchConversationLastMessageAt,
  markConversationHumanReplied,
} from '../db/models/conversation';
import { findContactById } from '../db/models/contact';
import { sendMessage } from '../services/channelSenderService';
import { socketService } from '../services/socketService';
import crypto from 'crypto';
import path from 'path';
import {
  listConversationsForTenant,
  findConversationDetailForTenant,
  listMessagesPageOldestFirst,
  setHumanOverride24h,
  countUnreadConversations,
} from '../services/conversationService';
import { sendSuccess, sendError } from '../utils/response';
import { logEvent } from '../services/analyticsService';
import { aiQueue } from '../jobs/queues';
import { uploadImage } from '../services/cloudinaryService';
import { uploadFile } from '../services/backblazeService';
import type {
  ConversationListQuery,
  ConversationMessagesQuery,
  ConversationReplyBody,
} from '../validators/conversation';

function isPgUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505',
  );
}

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as ConversationListQuery;

    const { rows, total } = await listConversationsForTenant({
      tenantId,
      page: query.page,
      limit: query.limit,
      channel: query.channel,
      status: query.status,
    });

    sendSuccess(
      res,
      {
        conversations: rows,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      },
      'Conversations retrieved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to retrieve conversations', 500, err);
  }
}

export async function unreadCount(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const count = await countUnreadConversations(tenantId);
    sendSuccess(res, { count }, 'Unread count retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve unread count', 500, err);
  }
}

export async function show(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = req.params as { id: string };
    const query = (req.validated?.query ?? req.query) as unknown as ConversationMessagesQuery;

    const conversation = await findConversationDetailForTenant(id, tenantId);
    if (!conversation) {
      sendError(res, 'Conversation not found', 404);
      return;
    }

    const { messages, hasMore, nextCursor } = await listMessagesPageOldestFirst({
      conversationId: id,
      tenantId,
      limit: query.limit,
      cursor: query.cursor ?? null,
    });

    sendSuccess(
      res,
      {
        conversation,
        messages,
        pagination: {
          hasMore,
          nextCursor,
        },
      },
      'Conversation retrieved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to retrieve conversation', 500, err);
  }
}

export async function reply(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = req.params as { id: string };
    const { text, attachment_urls: attachmentUrlsRaw } = req.body as ConversationReplyBody;
    const trimmedText = text.trim();
    const attachmentUrls = attachmentUrlsRaw ?? [];

    const conversation = await findConversationDetailForTenant(id, tenantId);
    if (!conversation) {
      sendError(res, 'Conversation not found', 404);
      return;
    }

    const [channel, contact] = await Promise.all([
      conversation.channel_id ? findChannelById(conversation.channel_id, tenantId) : null,
      findContactById(conversation.contact_id),
    ]);

    if (!channel) {
      sendError(res, 'Channel not found', 404);
      return;
    }
    if (!contact || contact.tenant_id !== tenantId) {
      sendError(res, 'Contact not found', 404);
      return;
    }

    await markConversationHumanReplied(id, tenantId);

    const messageType =
      attachmentUrls.length > 0 && !trimmedText ? 'image' : 'text';

    const textForChannel =
      trimmedText ||
      (attachmentUrls.length > 0 ? '[Image from team]' : '');

    const sendResult = textForChannel
      ? await sendMessage(channel, contact.external_id, textForChannel)
      : { success: true as const, graphMessageId: null as string | null };
    const channelDelivered = !textForChannel || sendResult.success;

    const extId = sendResult.graphMessageId ?? `human_${randomUUID()}`;

    let outboundMessage: Message;
    try {
      outboundMessage = await createMessage({
        tenant_id: tenantId,
        conversation_id: id,
        external_message_id: extId,
        direction: 'outbound',
        type: messageType,
        content: trimmedText || null,
        attachment_urls: attachmentUrls,
        sent_by: 'human',
      });
    } catch (err) {
      if (!isPgUniqueViolation(err)) {
        throw err;
      }
      const existing = await findMessageByExternalMessageId(extId);
      if (!existing || existing.tenant_id !== tenantId || existing.conversation_id !== id) {
        throw err;
      }
      outboundMessage = existing;
    }

    void logEvent(tenantId, 'human_reply_sent', {
      conversation_id: id,
      channel_id: channel.id,
      message_id: outboundMessage.id,
    });

    await setHumanOverride24h(id, tenantId);
    await touchConversationLastMessageAt(id);

    socketService.emitNewMessage(tenantId, outboundMessage);
    socketService.emitConversationUpdated(tenantId, id);

    const msg = channelDelivered
      ? 'Reply sent successfully'
      : 'Reply saved but channel delivery failed';

    sendSuccess(res, { message: outboundMessage, channelDelivered }, msg, 201);
  } catch (err) {
    sendError(res, 'Failed to send reply', 500, err);
  }
}

export async function close(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = req.params as { id: string };

    const updated = await updateConversationStatus(id, tenantId, 'closed');
    if (!updated) {
      sendError(res, 'Conversation not found', 404);
      return;
    }

    // Trigger immediate use case evaluation on explicit close.
    // Using the same jobId as the delayed version so BullMQ deduplicates them.
    void (aiQueue as unknown as { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> }).add(
      'evaluateConversationUseCase',
      { conversationId: id, tenantId },
      {
        delay: 0,
        jobId: `eval-usecase-${id}`,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    sendSuccess(res, { conversation: updated }, 'Conversation closed successfully');
  } catch (err) {
    sendError(res, 'Failed to close conversation', 500, err);
  }
}

export async function reopen(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = req.params as { id: string };

    const updated = await updateConversationStatus(id, tenantId, 'open');
    if (!updated) {
      sendError(res, 'Conversation not found', 404);
      return;
    }

    sendSuccess(res, { conversation: updated }, 'Conversation reopened successfully');
  } catch (err) {
    sendError(res, 'Failed to reopen conversation', 500, err);
  }
}

export async function uploadConversationAttachment(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = req.params as { id: string };

    const conversation = await findConversationDetailForTenant(id, tenantId);
    if (!conversation) {
      sendError(res, 'Conversation not found', 404);
      return;
    }

    const file = req.file;
    if (!file) {
      sendError(res, 'No file uploaded', 400);
      return;
    }

    const ext = path.extname(file.originalname || '').toLowerCase();
    const uniqueFilename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    const normalizedType = file.mimetype.toLowerCase();
    const permanentUrl = normalizedType.startsWith('image/')
      ? await uploadImage(file.buffer, 'attachments', uniqueFilename)
      : await uploadFile(file.buffer, uniqueFilename, normalizedType || 'application/octet-stream', 'other');

    sendSuccess(res, { url: permanentUrl }, 'Attachment uploaded successfully', 201);
  } catch (err) {
    sendError(res, 'Failed to upload attachment', 500, err);
  }
}
