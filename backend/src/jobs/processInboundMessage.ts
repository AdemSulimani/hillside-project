import { findChannelByTypeAndExternalId, type ChannelType } from '../db/models/channel';
import { upsertContact } from '../db/models/contact';
import { upsertConversation, touchConversationLastMessageAt } from '../db/models/conversation';
import { createMessage, findMessageByExternalMessageId } from '../db/models/message';
import {
  webhookNormalizerService,
  type InboundMessageDTO,
} from '../services/webhookNormalizer';
import { socketService } from '../services/socketService';
import { aiQueue } from './queues';

export interface InboundWebhookJobData {
  channelType: ChannelType;
  payload: Record<string, unknown>;
}

function normalize(channelType: ChannelType, payload: Record<string, unknown>): InboundMessageDTO {
  if (channelType === 'facebook') return webhookNormalizerService.normalizeFromFacebook(payload);
  if (channelType === 'instagram') return webhookNormalizerService.normalizeFromInstagram(payload);
  return webhookNormalizerService.normalizeFromWhatsApp(payload);
}

export async function processInboundMessage(data: InboundWebhookJobData): Promise<void> {
  const normalized = normalize(data.channelType, data.payload);

  const existingMessage = await findMessageByExternalMessageId(normalized.externalMessageId);
  if (existingMessage) {
    return;
  }

  const channel = await findChannelByTypeAndExternalId(
    normalized.channelType,
    normalized.channelExternalId,
  );
  if (!channel) {
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
    metadata: {
      raw_payload_contact: normalized.rawPayload,
    },
  });

  const conversation = await upsertConversation({
    tenant_id: channel.tenant_id,
    contact_id: contact.id,
    channel_id: channel.id,
    status: 'open',
  });

  const inboundMessage = await createMessage({
    tenant_id: channel.tenant_id,
    conversation_id: conversation.id,
    external_message_id: normalized.externalMessageId,
    direction: 'inbound',
    type: normalized.messageType,
    content: normalized.content,
    attachment_urls: normalized.attachmentUrls,
    sent_by: 'customer',
  });

  await touchConversationLastMessageAt(conversation.id);

  socketService.emitNewMessage(channel.tenant_id, inboundMessage);
  socketService.emitConversationUpdated(channel.tenant_id, conversation.id);

  await aiQueue.add('ai.reply', {
    tenantId: channel.tenant_id,
    channelId: channel.id,
    conversationId: conversation.id,
    messageExternalId: normalized.externalMessageId,
  });
}
