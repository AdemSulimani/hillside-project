import { findChannelByTypeAndExternalId, type ChannelType } from '../db/models/channel';
import { upsertContact } from '../db/models/contact';
import {
  upsertConversation,
  touchConversationLastMessageAt,
  markConversationHumanReplied,
} from '../db/models/conversation';
import { createMessage, findMessageIdByExternalMessageId } from '../db/models/message';
import {
  webhookNormalizerService,
  type InboundMessageDTO,
} from '../services/webhookNormalizer';
import { setHumanOverride24h } from '../services/conversationService';
import { downloadAndStore } from '../services/attachmentStorageService';
import { cryptoService } from '../services/cryptoService';
import { socketService } from '../services/socketService';
import { aiQueue } from './queues';
import { logEvent } from '../services/analyticsService';
import type { InboundWebhookJobData } from './jobTypes';

export type { InboundWebhookJobData } from './jobTypes';

function normalize(channelType: ChannelType, payload: Record<string, unknown>): InboundMessageDTO {
  if (channelType === 'facebook') return webhookNormalizerService.normalizeFromFacebook(payload);
  if (channelType === 'instagram') return webhookNormalizerService.normalizeFromInstagram(payload);
  return webhookNormalizerService.normalizeFromWhatsApp(payload);
}

function shouldIgnoreNormalizationError(channelType: ChannelType, err: unknown): boolean {
  if (channelType !== 'whatsapp' && channelType !== 'instagram' && channelType !== 'facebook') {
    return false;
  }
  if (!(err instanceof Error)) return false;
  return err.message.includes('required message identifiers are missing');
}

export async function processInboundMessage(data: InboundWebhookJobData): Promise<void> {
  let normalized: InboundMessageDTO;
  try {
    normalized = normalize(data.channelType, data.payload);
  } catch (err) {
    if (shouldIgnoreNormalizationError(data.channelType, err)) {
      const keys = Object.keys(data.payload);
      const entry0 = Array.isArray(data.payload.entry) ? data.payload.entry[0] : null;
      const entryObj =
        entry0 && typeof entry0 === 'object' && !Array.isArray(entry0)
          ? (entry0 as Record<string, unknown>)
          : null;
      const changes0 =
        entryObj && Array.isArray(entryObj.changes) ? entryObj.changes[0] : null;
      const ch =
        changes0 && typeof changes0 === 'object' && !Array.isArray(changes0)
          ? (changes0 as Record<string, unknown>)
          : null;
      console.info('[inbound] Ignoring non-message webhook event', {
        channelType: data.channelType,
        payloadKeys: keys,
        changeField: typeof ch?.field === 'string' ? ch.field : undefined,
      });
      return;
    }
    throw err;
  }

  const existingId = await findMessageIdByExternalMessageId(normalized.externalMessageId);
  if (existingId) {
    console.info('[inbound] Duplicate external_message_id, skipping processing', {
      external_message_id: normalized.externalMessageId,
      message_id: existingId,
    });
    return;
  }

  const channel = await findChannelByTypeAndExternalId(
    normalized.channelType,
    normalized.channelExternalId,
  );
  if (!channel) {
    console.error('[inbound] Channel not found — check channels.external_id matches webhook recipient/entry id', {
      channelType: normalized.channelType,
      channelExternalId: normalized.channelExternalId,
      contactExternalId: normalized.contactExternalId,
      externalMessageId: normalized.externalMessageId,
    });
    throw new Error(
      `Channel not found for type=${normalized.channelType} external_id=${normalized.channelExternalId}`,
    );
  }

  const contact = await upsertContact({
    tenant_id: channel.tenant_id,
    channel_id: channel.id,
    external_id: normalized.contactExternalId,
    name: normalized.contactName,
    avatar_url: normalized.contactAvatarUrl,
    metadata: {},
  });

  const conversation = await upsertConversation({
    tenant_id: channel.tenant_id,
    contact_id: contact.id,
    channel_id: channel.id,
    status: 'open',
  });

  let permanentAttachmentUrls = normalized.attachmentUrls;

  if (normalized.attachmentUrls.length > 0) {
    let accessToken: string | undefined;
    try {
      accessToken = cryptoService.decrypt(channel.access_token_encrypted);
    } catch {
      console.warn('[inbound] Could not decrypt channel access token for attachment download');
    }

    const stored: string[] = [];
    for (const ref of normalized.attachmentUrls) {
      try {
        const url = await downloadAndStore(ref, normalized.channelType, accessToken);
        stored.push(url);
      } catch (err) {
        console.error('[inbound] Failed to download attachment', { ref, err });
      }
    }

    if (stored.length > 0) {
      permanentAttachmentUrls = stored;
    }
  }

  const isNativeEcho =
    (normalized.channelType === 'instagram' || normalized.channelType === 'facebook') &&
    normalized.isEcho === true;

  if (isNativeEcho) {
    await markConversationHumanReplied(conversation.id, channel.tenant_id);

    const outboundMessage = await createMessage({
      tenant_id: channel.tenant_id,
      conversation_id: conversation.id,
      external_message_id: normalized.externalMessageId,
      direction: 'outbound',
      type: normalized.messageType,
      content: normalized.content,
      attachment_urls: permanentAttachmentUrls,
      sent_by: 'human',
    });

    await setHumanOverride24h(conversation.id, channel.tenant_id);
    await touchConversationLastMessageAt(conversation.id);

    void logEvent(channel.tenant_id, 'human_reply_sent', {
      conversation_id: conversation.id,
      channel_id: channel.id,
      channel_type: channel.type,
      message_id: outboundMessage.id,
      source: 'native_echo',
    });

    socketService.emitNewMessage(channel.tenant_id, outboundMessage);
    socketService.emitConversationUpdated(channel.tenant_id, conversation.id);
    return;
  }

  const inboundMessage = await createMessage({
    tenant_id: channel.tenant_id,
    conversation_id: conversation.id,
    external_message_id: normalized.externalMessageId,
    direction: 'inbound',
    type: normalized.messageType,
    content: normalized.content,
    attachment_urls: permanentAttachmentUrls,
    sent_by: 'customer',
  });

  await touchConversationLastMessageAt(conversation.id);

  void logEvent(channel.tenant_id, 'message_received', {
    conversation_id: conversation.id,
    channel_id: channel.id,
    channel_type: channel.type,
    message_id: inboundMessage.id,
  });

  socketService.emitNewMessage(channel.tenant_id, inboundMessage);
  socketService.emitConversationUpdated(channel.tenant_id, conversation.id);

  if (normalized.skipAiReply !== true) {
    await aiQueue.add('ai.reply', {
      tenantId: channel.tenant_id,
      channelId: channel.id,
      conversationId: conversation.id,
      messageExternalId: normalized.externalMessageId,
    });
  }
}
