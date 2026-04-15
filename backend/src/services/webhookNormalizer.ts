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

function instagramMessageText(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  if (typeof message.text === 'string') return message.text;
  const textObj = asRecord(message.text);
  if (typeof textObj?.body === 'string') return textObj.body;
  return null;
}

function instagramExternalMessageId(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  if (typeof message.mid === 'string' && message.mid.trim()) return message.mid.trim();
  if (typeof message.id === 'string' && message.id.trim()) return message.id.trim();
  const idNum = typeof message.id === 'number' && Number.isFinite(message.id) ? message.id : null;
  if (idNum !== null && idNum > 0) return String(Math.trunc(idNum));
  return null;
}

/** URLs or Graph media attachment_ids (resolved later in attachmentStorageService). */
function instagramAttachmentRefs(message: Record<string, unknown> | null): string[] {
  if (!message) return [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const refs: string[] = [];
  for (const raw of attachments) {
    const att = asRecord(raw);
    const payload = asRecord(att?.payload);
    if (typeof payload?.url === 'string' && payload.url.trim()) {
      refs.push(payload.url.trim());
      continue;
    }
    if (typeof payload?.attachment_id === 'string' && payload.attachment_id.trim()) {
      refs.push(payload.attachment_id.trim());
      continue;
    }
    if (typeof att?.url === 'string' && att.url.trim()) {
      refs.push(att.url.trim());
      continue;
    }
  }
  return refs;
}

function instagramAttachmentMessageType(message: Record<string, unknown> | null): MessageType {
  if (!message) return 'text';
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const first = attachments.length > 0 ? asRecord(attachments[0]) : null;
  const t = typeof first?.type === 'string' ? first.type.toLowerCase() : '';
  if (t === 'image' || t === 'video' || t === 'audio' || t === 'file') {
    if (t === 'video') return 'video';
    if (t === 'audio') return 'audio';
    if (t === 'file') return 'document';
    return 'image';
  }
  return instagramAttachmentRefs(message).length > 0 ? 'image' : 'text';
}

function instagramContactName(
  sender: Record<string, unknown> | null,
  value: Record<string, unknown> | null,
): string {
  if (sender && typeof sender.name === 'string' && sender.name.trim()) return sender.name.trim();
  if (value && typeof value.from_username === 'string' && value.from_username.trim()) {
    return value.from_username.trim();
  }
  return 'Unknown';
}

function instagramContactExternalId(
  message: Record<string, unknown> | null,
  sender: Record<string, unknown> | null,
  recipient: Record<string, unknown> | null,
): string | null {
  const isEcho = message?.is_echo === true;
  if (isEcho) {
    return coercePositiveGraphId(recipient?.id) ?? coercePositiveGraphId(sender?.id);
  }
  return coercePositiveGraphId(sender?.id) ?? coercePositiveGraphId(recipient?.id);
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
      coercePositiveGraphId(entry?.id) ??
      coercePositiveGraphId(value?.id) ??
      coercePositiveGraphId(recipient?.id);

    const contactExternalId = instagramContactExternalId(message, sender, recipient);
    const externalMessageId = instagramExternalMessageId(message);
    const content = instagramMessageText(message);

    const attachmentUrls = instagramAttachmentRefs(message);
    const messageType = instagramAttachmentMessageType(message);

    if (!channelExternalId || !externalMessageId || !contactExternalId) {
      throw new Error('Invalid webhook payload: required message identifiers are missing');
    }

    return {
      channelType: 'instagram',
      channelExternalId,
      externalMessageId,
      contactExternalId,
      contactName: instagramContactName(sender, value),
      contactAvatarUrl: null,
      messageType,
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
