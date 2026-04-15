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

/** Graph / Instagram IDs in JSON may be string or number; Meta dashboard tests use 0. */
function coercePositiveGraphId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return String(Math.trunc(value));
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s || s === '0') return null;
    return s;
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
    const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
    const changes = entry && Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
    const value = changes ? asRecord(changes.value) : null;
    const messagingItem = entry && Array.isArray(entry.messaging) ? asRecord(entry.messaging[0]) : null;

    const sender = (value ? asRecord(value.sender) : null) ?? (messagingItem ? asRecord(messagingItem.sender) : null);
    const recipient =
      (value ? asRecord(value.recipient) : null) ??
      (messagingItem ? asRecord(messagingItem.recipient) : null);
    const message =
      (value ? asRecord(value.message) : null) ?? (messagingItem ? asRecord(messagingItem.message) : null);
    const channelExternalId =
      coercePositiveGraphId(entry?.id) ?? coercePositiveGraphId(recipient?.id);

    const contactExternalId =
      coercePositiveGraphId(sender?.id) ?? coercePositiveGraphId(recipient?.id);
    const externalMessageId =
      typeof message?.mid === 'string'
        ? message.mid
        : typeof message?.id === 'string'
          ? message.id
          : null;
    const content = typeof message?.text === 'string' ? message.text : null;

    // Handle attachments.
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const attachmentUrls = attachments
      .map((a: unknown) => {
        const att = asRecord(a);
        const attachPayload = asRecord(att?.payload);
        return typeof attachPayload?.url === 'string' ? attachPayload.url : null;
      })
      .filter((url): url is string => url !== null);

    if (!channelExternalId || !externalMessageId || !contactExternalId) {
      throw new Error('Invalid webhook payload: required message identifiers are missing');
    }

    return {
      channelType: 'instagram',
      channelExternalId,
      externalMessageId,
      contactExternalId,
      contactName: 'Unknown',
      contactAvatarUrl: null,
      messageType: attachmentUrls.length > 0 ? 'image' : 'text',
      content,
      attachmentUrls,
      rawPayload: payload,
    };
  }

  normalizeFromWhatsApp(payload: Record<string, unknown>): InboundMessageDTO {
    const normalized = extractMetaMessage(payload);
    const entry = Array.isArray(payload.entry) ? asRecord(payload.entry[0]) : null;
    const changes = entry && Array.isArray(entry.changes) ? asRecord(entry.changes[0]) : null;
    const value = changes ? asRecord(changes.value) : null;
    const metadata = value ? asRecord(value.metadata) : null;
    const phoneNumberId =
      typeof metadata?.phone_number_id === 'string' ? metadata.phone_number_id : null;

    return {
      channelType: 'whatsapp',
      ...normalized,
      // For WhatsApp Cloud API we store channel.external_id as phone_number_id.
      // Incoming webhook entry.id is usually WABA id, which does not match our channel lookup.
      channelExternalId: phoneNumberId ?? normalized.channelExternalId,
    };
  }
}

export const webhookNormalizerService = new WebhookNormalizerService();
