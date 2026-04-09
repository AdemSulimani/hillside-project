import crypto from 'crypto';
import { findChannelById } from '../db/models/channel';
import { findConversationById } from '../db/models/conversation';
import { findContactById } from '../db/models/contact';
import { createMessage, findMessagesByConversation } from '../db/models/message';
import { generateReply } from '../services/aiService';
import { sendMessage } from '../services/channelSenderService';

export interface AIReplyJobData {
  tenantId: string;
  channelId: string;
  conversationId: string;
  messageExternalId: string;
}

export async function processAIReply(data: AIReplyJobData): Promise<void> {
  const { tenantId, channelId, conversationId } = data;

  const channel = await findChannelById(channelId, tenantId);
  if (!channel) {
    console.warn('[ai.reply] Channel not found, skipping', { channelId, tenantId });
    return;
  }

  if (!channel.ai_enabled) {
    console.info('[ai.reply] AI disabled for channel, skipping', { channelId });
    return;
  }

  const conversation = await findConversationById(conversationId);
  if (!conversation) {
    console.warn('[ai.reply] Conversation not found, skipping', { conversationId });
    return;
  }

  if (conversation.human_override_until && new Date(conversation.human_override_until) > new Date()) {
    console.info('[ai.reply] Human override active, skipping', {
      conversationId,
      until: conversation.human_override_until,
    });
    return;
  }

  const recentMessages = await findMessagesByConversation(conversationId, 10);
  const lastInbound = [...recentMessages].reverse().find((m) => m.direction === 'inbound');
  const inboundText = lastInbound?.content || '';

  if (!inboundText) {
    console.info('[ai.reply] No text content in inbound message, skipping');
    return;
  }

  const replyText = await generateReply(conversationId, tenantId, inboundText);

  const outboundMessage = await createMessage({
    tenant_id: tenantId,
    conversation_id: conversationId,
    external_message_id: `ai_${crypto.randomUUID()}`,
    direction: 'outbound',
    type: 'text',
    content: replyText,
    sent_by: 'ai',
  });

  const contact = await findContactById(conversation.contact_id);
  if (contact) {
    await sendMessage(channel, contact.external_id, replyText);
  } else {
    console.error('[ai.reply] Contact not found for conversation', {
      contactId: conversation.contact_id,
    });
  }

  // Socket.io broadcast placeholder — implemented in Step 11
  try {
    const { getIO } = await import('../socket');
    const io = getIO();
    io.to(`tenant:${tenantId}`).emit('new_message', {
      message: outboundMessage,
      conversationId,
    });
  } catch {
    // Socket.io not yet initialized — silently skip
  }
}
