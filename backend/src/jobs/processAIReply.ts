import crypto from 'crypto';
import pool from '../db/pool';
import { redisConnection } from './redisConnection';
import { findChannelById } from '../db/models/channel';
import {
  findConversationById,
  setConversationAiPaused,
  touchConversationLastMessageAt,
} from '../db/models/conversation';
import { findContactById } from '../db/models/contact';
import {
  createMessage,
  findMessagesByConversation,
  updateMessageSendFailure,
} from '../db/models/message';
import { createAIAlert, type AIAlert } from '../db/models/aiAlert';
import { createOrder, findLatestActiveOrderForConversation } from '../db/models/order';
import { findProductByNameCaseInsensitive } from '../db/models/product';
import { findAIConfigByTenant } from '../db/models/aiConfig';
import { generateReply } from '../services/aiService';
import {
  evaluateReply,
  evaluationTriggersAlert,
  getQualityThreshold,
  resolveStoredFlagReason,
} from '../services/aiQualityService';
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

function normalizeLooseText(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function messageSuggestsNewOrder(message: string): boolean {
  const t = normalizeLooseText(message);
  if (!t) return false;
  return [
    'new order',
    'another order',
    'one more',
    'again',
    'also order',
    'order again',
    'porosi tjeter',
    'porosi tjetër',
    'edhe nje',
    'edhe një',
    'nje tjeter',
    'një tjetër',
    'dua edhe',
    'shto edhe',
  ].some((needle) => t.includes(needle));
}

export async function processAIReply(data: AIReplyJobData): Promise<void> {
  const { tenantId, channelId, conversationId } = data;

  const parsedMax = parseInt(process.env.AI_MAX_REPLIES_PER_HOUR ?? '25', 10);
  const aiMaxRepliesPerHour =
    Number.isFinite(parsedMax) && parsedMax > 0 ? parsedMax : 25;
  const rateLimitKey = `ai_rate_limit:${conversationId}`;
  const rateCount = await redisConnection.incr(rateLimitKey);
  if (rateCount === 1) {
    await redisConnection.expire(rateLimitKey, 3600);
  }
  if (rateCount > aiMaxRepliesPerHour) {
    const client = await pool.connect();
    let alert: AIAlert | undefined;
    let messageContentForSocket: string | null = null;
    try {
      const { rows: msgRows } = await client.query<{ id: string; content: string | null }>(
        `SELECT id, content FROM messages
         WHERE conversation_id = $1 AND tenant_id = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [conversationId, tenantId],
      );
      const latestMessage = msgRows[0];
      await client.query('BEGIN');
      await setConversationAiPaused(conversationId, tenantId, true, client);
      if (latestMessage) {
        messageContentForSocket = latestMessage.content;
        alert = await createAIAlert(
          {
            tenant_id: tenantId,
            conversation_id: conversationId,
            message_id: latestMessage.id,
            reason: 'rate_limit_exceeded',
          },
          client,
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* no active transaction */
      }
      console.error('[ai.reply] Rate limit pause / alert failed', { conversationId, tenantId, err });
    } finally {
      client.release();
    }
    if (alert) {
      const channel = await findChannelById(channelId, tenantId);
      if (channel) {
        const conversation = await findConversationById(conversationId);
        const contactForAlert = conversation
          ? await findContactById(conversation.contact_id)
          : null;
        socketService.emitAIAlert(tenantId, {
          ...alert,
          message_content: messageContentForSocket,
          contact_name: contactForAlert?.name?.trim() || 'Customer',
          channel_type: channel.type,
          channel_name: channel.name,
        });
        socketService.emitConversationUpdated(tenantId, conversationId);
      }
    }
    console.warn('[ai.reply] AI rate limit exceeded for conversation', { conversationId, tenantId });
    return;
  }

  // Level 1: Global AI toggle
  const aiConfig = await findAIConfigByTenant(tenantId);
  if (!aiConfig?.is_active) {
    console.info('[ai.reply] AI globally disabled for tenant, skipping', { tenantId });
    return;
  }

  // Level 2: Per-channel toggle
  const channel = await findChannelById(channelId, tenantId);
  if (!channel) {
    console.warn('[ai.reply] Channel not found, skipping', { channelId, tenantId });
    return;
  }

  if (!channel.ai_enabled) {
    console.info('[ai.reply] AI disabled for channel, skipping', { channelId });
    return;
  }

  // Level 3: Per-conversation controls
  const conversation = await findConversationById(conversationId);
  if (!conversation) {
    console.warn('[ai.reply] Conversation not found, skipping', { conversationId });
    return;
  }

  if (conversation.ai_paused) {
    console.info('[ai.reply] AI paused for conversation, skipping', { conversationId });
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
  if (inboundText.startsWith('Customer sent a reaction:')) {
    console.info('[ai.reply] Skipping automated reply for reaction-only inbound', { conversationId });
    return;
  }
  const rawUrls = lastInbound?.attachment_urls;
  const attachmentUrls = Array.isArray(rawUrls)
    ? rawUrls.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : [];

  if (!inboundText && attachmentUrls.length === 0) {
    console.info('[ai.reply] No text content or attachments in inbound message, skipping');
    return;
  }

  const replyText = await generateReply(conversationId, tenantId, inboundText, attachmentUrls);

  if (replyText.trim() === '[NO_REPLY]') {
    return;
  }

  const qualityThreshold = getQualityThreshold();
  const qualityEval = await evaluateReply(inboundText, replyText, tenantId);
  const qualityFailing =
    qualityEval !== null && evaluationTriggersAlert(qualityEval, qualityThreshold);
  const qualityScore = qualityEval?.quality_score ?? null;
  const flagReason =
    qualityEval && qualityFailing ? resolveStoredFlagReason(qualityEval, qualityThreshold) : null;

  const contact = await findContactById(conversation.contact_id);
  let sendResult:
    | Awaited<ReturnType<typeof sendMessage>>
    | null = null;
  if (contact) {
    sendResult = await sendMessage(channel, contact.external_id, replyText);
  } else {
    console.error('[ai.reply] Contact not found for conversation', {
      contactId: conversation.contact_id,
    });
  }

  const outboundMessage = await createMessage({
    tenant_id: tenantId,
    conversation_id: conversationId,
    external_message_id: sendResult?.graphMessageId ?? `ai_${crypto.randomUUID()}`,
    direction: 'outbound',
    type: 'text',
    content: replyText,
    sent_by: 'ai',
    quality_score: qualityScore,
    flagged: qualityFailing,
    flag_reason: flagReason,
  });

  if (qualityFailing && flagReason) {
    const client = await pool.connect();
    let alert: AIAlert | undefined;
    try {
      await client.query('BEGIN');
      alert = await createAIAlert(
        {
          tenant_id: tenantId,
          conversation_id: conversationId,
          message_id: outboundMessage.id,
          reason: flagReason,
        },
        client,
      );
      await setConversationAiPaused(conversationId, tenantId, true, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('[ai.reply] Quality alert / pause failed', { conversationId, tenantId, err });
    } finally {
      client.release();
    }
    if (alert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
      socketService.emitConversationUpdated(tenantId, conversationId);
    }
  }

  await touchConversationLastMessageAt(conversationId);

  void logEvent(tenantId, 'ai_reply_sent', {
    conversation_id: conversationId,
    channel_id: channelId,
    message_id: outboundMessage.id,
  });

  socketService.emitNewMessage(tenantId, outboundMessage);
  socketService.emitConversationUpdated(tenantId, conversationId);

  if (!sendResult?.success) {
    const errReason = sendResult?.error ?? 'Contact not found for conversation';
    if (sendResult) {
      console.error('[ai.reply] Channel send failed', { conversationId, error: errReason });
    }
    await updateMessageSendFailure(outboundMessage.id, tenantId, 'failed', errReason);
    socketService.emitMessageSendFailed(tenantId, {
      messageId: outboundMessage.id,
      conversationId,
      error: errReason,
    });
    let alert: AIAlert | undefined;
    try {
      alert = await createAIAlert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        message_id: outboundMessage.id,
        reason: 'message_send_failed',
      });
    } catch (alertErr) {
      console.error('[ai.reply] message_send_failed alert insert failed', {
        conversationId,
        tenantId,
        err: alertErr,
      });
    }
    if (alert) {
      const contactForAlert = await findContactById(conversation.contact_id);
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: outboundMessage.content,
        contact_name: contactForAlert?.name?.trim() || 'Customer',
        channel_type: channel.type,
        channel_name: channel.name,
      });
    }
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

    const latestActiveOrder = await findLatestActiveOrderForConversation(tenantId, conversationId);
    if (latestActiveOrder) {
      const incomingProduct = normalizeLooseText(productName);
      const existingProduct = normalizeLooseText(latestActiveOrder.product_name);
      const productChanged = incomingProduct.length > 0 && incomingProduct !== existingProduct;
      const explicitNewOrder = messageSuggestsNewOrder(inboundText);

      if (!productChanged && !explicitNewOrder) {
        console.info('[ai.reply] Skipping duplicate order creation', {
          conversationId,
          existingOrderId: latestActiveOrder.id,
          productName,
          intent_score: intent.intent_score,
        });
        return;
      }
    }

    const { rows: humanRows } = await pool.query<{ human_replied: boolean }>(
      'SELECT human_replied FROM conversations WHERE id = $1 LIMIT 1',
      [conversationId],
    );
    const humanReplied = humanRows[0]?.human_replied === true;
    const isCommissionable = !humanReplied;
    const commissionAmount = isCommissionable
      ? Math.round(totalPrice * 0.05 * 100) / 100
      : null;

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
      is_commissionable: isCommissionable,
      commission_amount: commissionAmount,
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
