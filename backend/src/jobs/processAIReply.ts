import crypto from 'crypto';
import { findChannelById } from '../db/models/channel';
import { findConversationById, touchConversationLastMessageAt } from '../db/models/conversation';
import { findContactById } from '../db/models/contact';
import { createMessage, findMessagesByConversation } from '../db/models/message';
import { createOrder } from '../db/models/order';
import { findProductByNameCaseInsensitive } from '../db/models/product';
import { generateReply } from '../services/aiService';
import { detect } from '../services/intentDetectionService';
import { sendMessage } from '../services/channelSenderService';
import { socketService } from '../services/socketService';
import { logEvent } from '../services/analyticsService';

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
  const inboundText = (lastInbound?.content ?? '').trim();
  const rawUrls = lastInbound?.attachment_urls;
  const attachmentUrls = Array.isArray(rawUrls)
    ? rawUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];

  if (!inboundText && attachmentUrls.length === 0) {
    console.info('[ai.reply] No text content or attachments in inbound message, skipping');
    return;
  }

  const replyText = await generateReply(conversationId, tenantId, inboundText, attachmentUrls);

  const outboundMessage = await createMessage({
    tenant_id: tenantId,
    conversation_id: conversationId,
    external_message_id: `ai_${crypto.randomUUID()}`,
    direction: 'outbound',
    type: 'text',
    content: replyText,
    sent_by: 'ai',
  });

  await touchConversationLastMessageAt(conversationId);

  void logEvent(tenantId, 'ai_reply_sent', {
    conversation_id: conversationId,
    channel_id: channelId,
    message_id: outboundMessage.id,
  });

  socketService.emitNewMessage(tenantId, outboundMessage);
  socketService.emitConversationUpdated(tenantId, conversationId);

  const contact = await findContactById(conversation.contact_id);
  if (contact) {
    try {
      await sendMessage(channel, contact.external_id, replyText);
    } catch (err) {
      console.error('[ai.reply] Channel send failed', { conversationId, err });
    }
  } else {
    console.error('[ai.reply] Contact not found for conversation', {
      contactId: conversation.contact_id,
    });
  }

  try {
    if (!contact) {
      return;
    }

    const messagesForIntent = await findMessagesByConversation(conversationId, 40);
    const intent = await detect(messagesForIntent, tenantId);

    if (!intent.is_ready_to_order || intent.intent_score <= 0.75) {
      return;
    }

    const nameFromIntent = intent.product_name?.trim();
    const matchedProduct = nameFromIntent
      ? await findProductByNameCaseInsensitive(tenantId, nameFromIntent)
      : null;

    const productName = matchedProduct?.name ?? nameFromIntent;
    if (!productName) {
      console.info('[ai.reply] Order intent detected but no product name to record', {
        conversationId,
        intent_score: intent.intent_score,
      });
      return;
    }

    const quantity = Math.max(1, intent.quantity ?? 1);
    const unitPrice = matchedProduct ? Number(matchedProduct.price) : 0;
    const totalPrice = unitPrice * quantity;

    const meta = contact.metadata ?? {};
    const phoneRaw = meta.phone ?? meta.phone_number ?? meta.phoneNumber;
    const customerPhone =
      typeof phoneRaw === 'string' && phoneRaw.trim() ? phoneRaw.trim() : null;

    const order = await createOrder({
      tenant_id: tenantId,
      conversation_id: conversationId,
      contact_id: conversation.contact_id,
      product_id: matchedProduct?.id ?? null,
      product_name: productName,
      quantity,
      unit_price: unitPrice,
      total_price: totalPrice,
      status: 'draft',
      customer_name: contact.name || 'Unknown',
      customer_phone: customerPhone,
      delivery_address: intent.delivery_address,
      notes: null,
      detected_by: 'ai',
    });

    void logEvent(tenantId, 'order_created', {
      order_id: order.id,
      conversation_id: conversationId,
      product_id: order.product_id,
      product_name: order.product_name,
      quantity: order.quantity,
    });

    socketService.emitOrderCreated(tenantId, order);
  } catch (err) {
    console.error('[ai.reply] Intent detection or draft order failed', {
      conversationId,
      tenantId,
      err,
    });
  }
}
