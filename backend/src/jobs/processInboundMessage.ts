import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import { findChannelByTypeAndExternalId, type ChannelType } from '../db/models/channel';
import { findContactByExternalIdForTenantChannel, upsertContact } from '../db/models/contact';
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
import { cryptoService } from '../services/cryptoService';
import { socketService } from '../services/socketService';
import { uploadImage } from '../services/cloudinaryService';
import { uploadFile } from '../services/backblazeService';
import { aiQueue } from './queues';
import { logEvent } from '../services/analyticsService';
import type { InboundWebhookJobData } from './jobTypes';

export type { InboundWebhookJobData } from './jobTypes';

const GRAPH_API_BASE = 'https://graph.facebook.com/v25.0';
const INSTAGRAM_GRAPH_API_BASE = 'https://graph.instagram.com/v25.0';
const PROFILE_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROFILE_LAST_LOOKUP_METADATA_KEY = 'profile_last_lookup_at';

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
};

function extensionFromContentType(contentType: string): string {
  const base = contentType.split(';')[0].trim().toLowerCase();
  return CONTENT_TYPE_TO_EXT[base] ?? '';
}

async function resolveMetaMediaUrl(mediaId: string, accessToken: string): Promise<string> {
  const { data } = await axios.get(`${GRAPH_API_BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (typeof data.url !== 'string') {
    throw new Error(`Failed to resolve media URL for id=${mediaId}`);
  }
  return data.url;
}

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

function isProfileLookupDebugEnabled(): boolean {
  const v = process.env.WEBHOOK_DEBUG?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function readProfileLastLookupAt(metadata: Record<string, unknown> | null | undefined): Date | null {
  const raw = metadata?.[PROFILE_LAST_LOOKUP_METADATA_KEY];
  if (typeof raw !== 'string' || !raw.trim()) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function shouldRefreshProfileLookup(
  channelType: ChannelType,
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  if (channelType !== 'instagram' && channelType !== 'facebook') {
    return false;
  }
  const lastLookupAt = readProfileLastLookupAt(metadata);
  if (!lastLookupAt) {
    return true;
  }
  return Date.now() - lastLookupAt.getTime() >= PROFILE_REFRESH_INTERVAL_MS;
}

async function resolveInstagramContactProfile(
  contactExternalId: string,
  accessToken: string,
): Promise<{ name: string | null; avatarUrl: string | null; username: string | null }> {
  const endpoints: Array<{ base: string; fields: string }> = [
    // Instagram Graph supports `profile_pic` (not `profile_picture_url`).
    { base: INSTAGRAM_GRAPH_API_BASE, fields: 'name,username,profile_pic' },
    // Fallback for Meta Graph style payloads.
    { base: GRAPH_API_BASE, fields: 'name,username,profile_picture_url' },
  ];

  for (const endpoint of endpoints) {
    try {
      const resp = await axios.get(`${endpoint.base}/${contactExternalId}`, {
        params: {
          fields: endpoint.fields,
          access_token: accessToken,
        },
      });
      const data = resp.data as {
        name?: unknown;
        username?: unknown;
        profile_pic?: unknown;
        profile_picture_url?: unknown;
      };
      const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
      const username =
        typeof data.username === 'string' && data.username.trim() ? data.username.trim() : null;
      const avatarUrl =
        typeof data.profile_pic === 'string' && data.profile_pic.trim()
          ? data.profile_pic.trim()
          : typeof data.profile_picture_url === 'string' && data.profile_picture_url.trim()
            ? data.profile_picture_url.trim()
          : null;

      if (name || username || avatarUrl) {
        return { name, avatarUrl, username };
      }
      if (isProfileLookupDebugEnabled()) {
        console.info('[inbound] Instagram profile lookup returned no display fields', {
          endpoint: endpoint.base,
          contactExternalId,
        });
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const graphError = err.response?.data as
          | {
              error?: {
                message?: unknown;
                type?: unknown;
                code?: unknown;
                error_subcode?: unknown;
                fbtrace_id?: unknown;
              };
            }
          | undefined;
        const e = graphError?.error;
        if (isProfileLookupDebugEnabled()) {
          console.warn('[inbound] Instagram profile lookup failed', {
            endpoint: endpoint.base,
            contactExternalId,
            status: err.response?.status ?? null,
            code: typeof e?.code === 'number' ? e.code : e?.code ?? null,
            subcode: typeof e?.error_subcode === 'number' ? e.error_subcode : e?.error_subcode ?? null,
            type: typeof e?.type === 'string' ? e.type : null,
            message: typeof e?.message === 'string' ? e.message : err.message,
            fbtraceId: typeof e?.fbtrace_id === 'string' ? e.fbtrace_id : null,
          });
        }
        continue;
      }
      if (isProfileLookupDebugEnabled()) {
        console.warn('[inbound] Instagram profile lookup failed (non-axios)', {
          endpoint: endpoint.base,
          contactExternalId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      // Try next endpoint; if both fail, caller falls back to current values.
    }
  }

  return { name: null, avatarUrl: null, username: null };
}

async function resolveFacebookContactProfile(
  contactExternalId: string,
  accessToken: string,
): Promise<{ name: string | null; avatarUrl: string | null }> {
  try {
    const resp = await axios.get(`${GRAPH_API_BASE}/${contactExternalId}`, {
      params: {
        fields: 'name,profile_pic',
        access_token: accessToken,
      },
    });
    const data = resp.data as { name?: unknown; profile_pic?: unknown };
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
    const avatarUrl =
      typeof data.profile_pic === 'string' && data.profile_pic.trim()
        ? data.profile_pic.trim()
        : null;
    return { name, avatarUrl };
  } catch (err) {
    if (isProfileLookupDebugEnabled() && axios.isAxiosError(err)) {
      const graphError = err.response?.data as
        | {
            error?: {
              message?: unknown;
              type?: unknown;
              code?: unknown;
              error_subcode?: unknown;
              fbtrace_id?: unknown;
            };
          }
        | undefined;
      const e = graphError?.error;
      console.warn('[inbound] Facebook profile lookup failed', {
        contactExternalId,
        status: err.response?.status ?? null,
        code: typeof e?.code === 'number' ? e.code : e?.code ?? null,
        subcode: typeof e?.error_subcode === 'number' ? e.error_subcode : e?.error_subcode ?? null,
        type: typeof e?.type === 'string' ? e.type : null,
        message: typeof e?.message === 'string' ? e.message : err.message,
        fbtraceId: typeof e?.fbtrace_id === 'string' ? e.fbtrace_id : null,
      });
    }
    return { name: null, avatarUrl: null };
  }
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

  let contactName = normalized.contactName;
  let contactAvatarUrl = normalized.contactAvatarUrl;
  let contactMetadata: Record<string, unknown> = {};
  const existingContact = await findContactByExternalIdForTenantChannel(
    channel.tenant_id,
    channel.id,
    normalized.contactExternalId,
  );
  const shouldRefreshProfile = shouldRefreshProfileLookup(
    normalized.channelType,
    existingContact?.metadata,
  );

  if (shouldRefreshProfile) {
    contactMetadata[PROFILE_LAST_LOOKUP_METADATA_KEY] = new Date().toISOString();
  }

  if (normalized.channelType === 'instagram' && shouldRefreshProfile) {
    try {
      const accessToken = cryptoService.decrypt(channel.access_token_encrypted);
      const profile = await resolveInstagramContactProfile(normalized.contactExternalId, accessToken);
      if (profile.name || profile.username) {
        contactName = profile.name ?? profile.username!;
      }
      if (profile.avatarUrl) {
        contactAvatarUrl = profile.avatarUrl;
      }
      if (profile.username) {
        contactMetadata.username = profile.username;
      }
    } catch (err) {
      console.warn('[inbound] Could not resolve instagram contact profile', {
        contactExternalId: normalized.contactExternalId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (normalized.channelType === 'facebook' && shouldRefreshProfile) {
    try {
      const accessToken = cryptoService.decrypt(channel.access_token_encrypted);
      const profile = await resolveFacebookContactProfile(normalized.contactExternalId, accessToken);
      if (profile.name) {
        contactName = profile.name;
      }
      if (profile.avatarUrl) {
        contactAvatarUrl = profile.avatarUrl;
      }
    } catch (err) {
      console.warn('[inbound] Could not resolve facebook contact profile', {
        contactExternalId: normalized.contactExternalId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const contact = await upsertContact({
    tenant_id: channel.tenant_id,
    channel_id: channel.id,
    external_id: normalized.contactExternalId,
    name: contactName,
    avatar_url: contactAvatarUrl,
    metadata: contactMetadata,
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
        const isUrl = ref.startsWith('http://') || ref.startsWith('https://');
        const headers: Record<string, string> = {};
        let downloadUrl = ref;

        if (!isUrl && accessToken) {
          downloadUrl = await resolveMetaMediaUrl(ref, accessToken);
          headers.Authorization = `Bearer ${accessToken}`;
        } else if (
          isUrl &&
          (normalized.channelType === 'whatsapp' ||
            normalized.channelType === 'facebook' ||
            normalized.channelType === 'instagram') &&
          accessToken
        ) {
          headers.Authorization = `Bearer ${accessToken}`;
        }

        const response = await axios.get<ArrayBuffer>(downloadUrl, {
          responseType: 'arraybuffer',
          headers: Object.keys(headers).length > 0 ? headers : undefined,
        });
        const contentType =
          typeof response.headers['content-type'] === 'string'
            ? response.headers['content-type']
            : 'application/octet-stream';
        const normalizedType = contentType.split(';')[0].trim().toLowerCase();
        const ext = extensionFromContentType(contentType);
        const uniqueFilename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${
          ext || path.extname(downloadUrl) || ''
        }`;
        const buffer = Buffer.from(response.data);

        let url: string;
        if (normalizedType.startsWith('image/')) {
          url = await uploadImage(buffer, 'attachments', uniqueFilename);
        } else if (normalizedType.startsWith('audio/')) {
          url = await uploadFile(buffer, uniqueFilename, normalizedType, 'audio');
        } else if (
          normalizedType === 'application/pdf' ||
          normalizedType.startsWith('application/msword') ||
          normalizedType.startsWith('application/vnd') ||
          normalizedType.startsWith('text/')
        ) {
          url = await uploadFile(buffer, uniqueFilename, normalizedType, 'documents');
        } else {
          url = await uploadFile(buffer, uniqueFilename, normalizedType, 'other');
        }
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
    const aiReplyDelayMs = Number(process.env.AI_REPLY_DELAY_MS ?? '8000');
    const pendingAiReplyJobs = await aiQueue.getJobs(['delayed', 'waiting']);
    const existingJob = pendingAiReplyJobs.find(
      (job) => job.name === 'ai.reply' && job.data?.conversationId === conversation.id,
    );

    if (existingJob) {
      await existingJob.remove();
    }

    await aiQueue.add('ai.reply', {
      tenantId: channel.tenant_id,
      channelId: channel.id,
      conversationId: conversation.id,
      messageExternalId: normalized.externalMessageId,
    }, {
      delay: Number.isFinite(aiReplyDelayMs) ? aiReplyDelayMs : 8000,
    });
  }
}
