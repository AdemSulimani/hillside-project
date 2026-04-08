import type { ChannelType } from '../db/models/channel';
import type { MessageType } from '../db/models/message';

export interface InboundMessageDTO {
  channelType: ChannelType;
  channelExternalId: string;
  externalMessageId: string;
  contactExternalId: string;
  contactName: string;
  contactAvatarUrl: string | null;
  messageType: MessageType;
  content: string | null;
  attachmentUrls: string[];
  rawPayload: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function pickMessageType(message: Record<string, unknown>): MessageType {
  if (typeof message.type === 'string') {
    const rawType = message.type.toLowerCase();
    if (rawType === 'text') return 'text';
    if (rawType === 'image') return 'image';
    if (rawType === 'audio') return 'audio';
    if (rawType === 'video') return 'video';
    if (rawType === 'document') return 'document';
  }
  return 'text';
}

function extractMetaMessage(
  payload: Record<string, unknown>,
): Omit<InboundMessageDTO, 'channelType'> {
  const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
  const changes = entry && Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
  const value = changes ? asRecord(changes.value) : null;
  const contact = value && Array.isArray(value.contacts) ? asRecord(value.contacts[0]) : null;
  const message = value && Array.isArray(value.messages) ? asRecord(value.messages[0]) : null;

  const channelExternalId = typeof entry?.id === 'string' ? entry.id : null;
  const externalMessageId = typeof message?.id === 'string' ? message.id : null;
  const contactExternalId =
    typeof contact?.wa_id === 'string'
      ? contact.wa_id
      : typeof message?.from === 'string'
        ? message.from
        : null;
  const contactName =
    typeof (asRecord(contact?.profile)?.name) === 'string'
      ? String(asRecord(contact?.profile)?.name)
      : 'Unknown';

  const messageType = message ? pickMessageType(message) : 'text';
  const textObject = asRecord(message?.text);
  const imageObject = asRecord(message?.image);
  const videoObject = asRecord(message?.video);
  const audioObject = asRecord(message?.audio);
  const documentObject = asRecord(message?.document);

  const content =
    typeof textObject?.body === 'string'
      ? textObject.body
      : typeof documentObject?.caption === 'string'
        ? documentObject.caption
        : null;

  const mediaUrl =
    typeof imageObject?.id === 'string'
      ? imageObject.id
      : typeof videoObject?.id === 'string'
        ? videoObject.id
        : typeof audioObject?.id === 'string'
          ? audioObject.id
          : typeof documentObject?.id === 'string'
            ? documentObject.id
            : null;

  if (!channelExternalId || !externalMessageId || !contactExternalId) {
    throw new Error('Invalid webhook payload: required message identifiers are missing');
  }

  return {
    channelExternalId,
    externalMessageId,
    contactExternalId,
    contactName,
    contactAvatarUrl: null,
    messageType,
    content,
    attachmentUrls: mediaUrl ? [mediaUrl] : [],
    rawPayload: payload,
  };
}

export class WebhookNormalizerService {
  normalizeFromFacebook(payload: Record<string, unknown>): InboundMessageDTO {
    return {
      channelType: 'facebook',
      ...extractMetaMessage(payload),
    };
  }

  normalizeFromInstagram(payload: Record<string, unknown>): InboundMessageDTO {
    return {
      channelType: 'instagram',
      ...extractMetaMessage(payload),
    };
  }

  normalizeFromWhatsApp(payload: Record<string, unknown>): InboundMessageDTO {
    return {
      channelType: 'whatsapp',
      ...extractMetaMessage(payload),
    };
  }
}

export const webhookNormalizerService = new WebhookNormalizerService();
