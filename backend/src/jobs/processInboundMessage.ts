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
import {
  applyMessageEdit,
  createMessage,
  existsOutboundAfter,
  findMessageByExternalMessageIdForTenant,
  findMessageByIdForTenant,
  findMessageIdByExternalMessageId,
  findRecentOutboundMessageByContent,
  buildReplySnapshotFromMessage,
  updateMessageReplyExternalOnly,
  updateMessageReplyResolved,
} from '../db/models/message';
import {
  isHumanAgentEcho,
  webhookNormalizerService,
  type InboundEditDTO,
  type InboundEvent,
  type InboundMessageDTO,
} from '../services/webhookNormalizer';
import {
  messageToReplyToPayload,
  setHumanOverrideHold,
  type MessageReplyToPayload,
} from '../services/conversationService';
import { wasSelfSentMessageEcho } from '../services/outboundEchoRegistry';
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
/** When display name is still a placeholder, retry User Profile API sooner (Meta may return `{}` until BAUPA / opt-in). */
const PROFILE_ATTEMPT_THROTTLE_MS = 10 * 60 * 1000;
const PROFILE_LAST_LOOKUP_METADATA_KEY = 'profile_last_lookup_at';
const PROFILE_LAST_ATTEMPT_METADATA_KEY = 'profile_last_attempt_at';
/**
 * How far back to look for an already-stored outbound message when de-duplicating an
 * API-originated echo whose `mid` didn't match the id we recorded at send time. Echoes
 * normally arrive within seconds; a few minutes is a safe upper bound.
 */
const ECHO_DEDUP_WINDOW_MS = 5 * 60 * 1000;

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

function normalize(channelType: ChannelType, payload: Record<string, unknown>): InboundEvent {
  return webhookNormalizerService.normalizeEvent(channelType, payload);
}

/**
 * Applies a platform edit to a previously-stored message. Idempotent on duplicate webhook
 * deliveries (same content => no-op). When an edit lands on a customer message that already has
 * an outbound (AI/human) reply after it, we re-enqueue an AI job so the assistant can correct
 * itself with the updated context.
 */
async function processInboundEdit(edit: InboundEditDTO): Promise<void> {
  const channel = await findChannelByTypeAndExternalId(edit.channelType, edit.channelExternalId);
  if (!channel) {
    console.warn('[inbound] Edit ignored — channel not found for edited message', {
      channelType: edit.channelType,
      channelExternalId: edit.channelExternalId,
      originalExternalMessageId: edit.originalExternalMessageId,
    });
    return;
  }

  const existing = await findMessageByExternalMessageIdForTenant(
    channel.tenant_id,
    edit.originalExternalMessageId,
  );
  if (!existing) {
    // Edits can arrive for messages we never stored (e.g. webhook ordering, prior failure to
    // ingest). Logging-only — there is nothing else to update.
    console.info('[inbound] Edit ignored — original message not found', {
      channelType: edit.channelType,
      originalExternalMessageId: edit.originalExternalMessageId,
    });
    return;
  }

  // Edit notifications only update inbound (customer) rows. Outbound edits are not exposed by
  // the platforms today, but guard against odd payloads regardless.
  if (existing.direction !== 'inbound') {
    console.info('[inbound] Edit ignored — target message is not inbound', {
      messageId: existing.id,
      direction: existing.direction,
    });
    return;
  }

  const result = await applyMessageEdit({
    messageId: existing.id,
    tenantId: channel.tenant_id,
    newContent: edit.newContent,
    newAttachmentUrls: edit.newAttachmentUrls,
    editedAt: edit.editedAt,
    numEdit: edit.numEdit ?? null,
  });

  if (!result) {
    console.warn('[inbound] Edit could not be applied (row vanished)', {
      messageId: existing.id,
    });
    return;
  }

  if (!result.changed) {
    // Duplicate edit delivery (same content). Don't broadcast; nothing changed for the UI.
    return;
  }

  socketService.emitMessageEdited(channel.tenant_id, result.message);
  socketService.emitConversationUpdated(channel.tenant_id, existing.conversation_id);

  void logEvent(channel.tenant_id, 'message_edited', {
    conversation_id: existing.conversation_id,
    channel_id: channel.id,
    channel_type: channel.type,
    message_id: existing.id,
    num_edit: edit.numEdit ?? null,
  });

  // Case B from the design: the AI/agent has already replied based on the original. Trigger a
  // follow-up reply so the assistant can correct itself. The AI job re-reads the (now-edited)
  // history and the staleness guard at processAIReply.ts will ignore newer inbound traffic.
  const hasOutboundAfter = await existsOutboundAfter(
    existing.conversation_id,
    channel.tenant_id,
    existing.created_at,
  );
  if (!hasOutboundAfter) {
    // Case A: no outbound followed, the original AI job will see the new content when it runs.
    return;
  }

  const aiReplyDelayMs = Number(process.env.AI_REPLY_DELAY_MS ?? '8000');
  const pendingAiReplyJobs = await aiQueue.getJobs(['delayed', 'waiting']);
  const existingJob = pendingAiReplyJobs.find(
    (job) => job.name === 'ai.reply' && job.data?.conversationId === existing.conversation_id,
  );
  if (existingJob) {
    await existingJob.remove();
  }
  await aiQueue.add(
    'ai.reply',
    {
      tenantId: channel.tenant_id,
      channelId: channel.id,
      conversationId: existing.conversation_id,
      messageExternalId: existing.external_message_id,
    },
    {
      delay: Number.isFinite(aiReplyDelayMs) ? aiReplyDelayMs : 8000,
    },
  );
}

function shouldIgnoreNormalizationError(channelType: ChannelType, err: unknown): boolean {
  if (channelType !== 'whatsapp' && channelType !== 'instagram' && channelType !== 'facebook') {
    return false;
  }
  if (!(err instanceof Error)) return false;
  return err.message.includes('required message identifiers are missing');
}

function isFallbackContactLabel(name: string): boolean {
  const trimmed = name.trim();
  if (!trimmed) return true;
  if (trimmed.toLowerCase() === 'unknown') return true;
  if (/^ig user \d+$/i.test(trimmed)) return true;
  return /^messenger user \d+$/i.test(trimmed);
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

function readProfileLastAttemptAt(metadata: Record<string, unknown> | null | undefined): Date | null {
  const raw = metadata?.[PROFILE_LAST_ATTEMPT_METADATA_KEY];
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
  existingContactName?: string | null,
): boolean {
  if (channelType !== 'instagram' && channelType !== 'facebook') {
    return false;
  }
  const hasExistingName =
    typeof existingContactName === 'string' && existingContactName.trim().length > 0;
  const isFallback = hasExistingName && isFallbackContactLabel(existingContactName!);
  const lastAttemptAt = readProfileLastAttemptAt(metadata);
  if (isFallback) {
    if (!lastAttemptAt) {
      return true;
    }
    return Date.now() - lastAttemptAt.getTime() >= PROFILE_ATTEMPT_THROTTLE_MS;
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
        // Messenger User Profile API: `name` may be absent; docs use first_name + last_name.
        fields: 'name,first_name,last_name,profile_pic',
        access_token: accessToken,
      },
    });
    const data = resp.data as {
      name?: unknown;
      first_name?: unknown;
      last_name?: unknown;
      profile_pic?: unknown;
    };
    const fromParts = [
      typeof data.first_name === 'string' ? data.first_name.trim() : '',
      typeof data.last_name === 'string' ? data.last_name.trim() : '',
    ]
      .filter(Boolean)
      .join(' ')
      .trim();
    const name =
      typeof data.name === 'string' && data.name.trim()
        ? data.name.trim()
        : fromParts || null;
    const avatarUrl =
      typeof data.profile_pic === 'string' && data.profile_pic.trim()
        ? data.profile_pic.trim()
        : null;
    if (!name && !avatarUrl && isProfileLookupDebugEnabled()) {
      const keys = resp.data && typeof resp.data === 'object' && !Array.isArray(resp.data)
        ? Object.keys(resp.data as object)
        : [];
      console.info('[inbound] Facebook profile lookup returned no fields (empty object or no access)', {
        contactExternalId,
        responseKeys: keys,
      });
    }
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
  const { traceId } = data;
  console.info('[webhook] processInboundMessage start', { traceId, channelType: data.channelType });

  let event: InboundEvent;
  try {
    event = normalize(data.channelType, data.payload);
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

  if (event.kind === 'edit') {
    await processInboundEdit(event);
    return;
  }
  const normalized: InboundMessageDTO = event;

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
    existingContact?.name,
  );

  let resolvedProfileFromApi = false;

  // Instagram webhook payloads may omit sender display info on later events; avoid
  // replacing a known real name with fallback labels like "IG user 123...".
  if (
    normalized.channelType === 'instagram' &&
    existingContact?.name &&
    isFallbackContactLabel(contactName) &&
    !isFallbackContactLabel(existingContact.name)
  ) {
    contactName = existingContact.name;
  }

  // Same for Messenger: later webhooks often omit sender.name; keep a resolved name when we have one.
  if (
    normalized.channelType === 'facebook' &&
    existingContact?.name &&
    isFallbackContactLabel(contactName) &&
    !isFallbackContactLabel(existingContact.name)
  ) {
    contactName = existingContact.name;
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
      if (profile.name || profile.username || profile.avatarUrl) {
        resolvedProfileFromApi = true;
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
      if (profile.name || profile.avatarUrl) {
        resolvedProfileFromApi = true;
      }
    } catch (err) {
      console.warn('[inbound] Could not resolve facebook contact profile', {
        contactExternalId: normalized.contactExternalId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (shouldRefreshProfile) {
    const profileLookupStampEarned =
      resolvedProfileFromApi ||
      !isFallbackContactLabel(normalized.contactName) ||
      !isFallbackContactLabel(contactName);
    if (profileLookupStampEarned) {
      contactMetadata[PROFILE_LAST_LOOKUP_METADATA_KEY] = new Date().toISOString();
    } else {
      contactMetadata[PROFILE_LAST_ATTEMPT_METADATA_KEY] = new Date().toISOString();
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
  /** When a story share is declared `image` but Meta's CDN returns MP4, we still persist the clip. */
  let resolvedInboundMessageType: typeof normalized.messageType = normalized.messageType;

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

        // Defensive: when the message is declared as an image (e.g. rich share preview) but the
        // downloaded asset isn't actually an image (e.g. Instagram permalink returning HTML),
        // skip storing it — otherwise the vision model would receive an HTML URL as `image_url`
        // and silently fail.
        //
        // Exception: Instagram "story shared" previews often use `lookaside.fbsbx.com` URLs that
        // return `video/mp4` even when the customer thinks of it as a photo story. We still persist
        // the clip so the inbox can render a `<video>` preview and the thread isn't empty.
        const isStoryShareInbound =
          typeof normalized.content === 'string' &&
          normalized.content.includes('Customer shared a story');
        if (normalized.messageType === 'image' && !normalizedType.startsWith('image/')) {
          if (isStoryShareInbound && normalizedType.startsWith('video/')) {
            const uploaded = await uploadFile(buffer, uniqueFilename, normalizedType, 'video');
            stored.push(uploaded);
            resolvedInboundMessageType = 'video';
            continue;
          }
          console.warn('[inbound] Skipping non-image attachment for image-typed message', {
            ref,
            contentType,
          });
          continue;
        }

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
    } else {
      // Every download failed or was filtered out — fall back to an empty list so we don't
      // keep the raw Meta lookaside URLs (which expire quickly and aren't usable by the vision model).
      permanentAttachmentUrls = [];
    }
  }

  const isNativeEcho =
    (normalized.channelType === 'instagram' || normalized.channelType === 'facebook') &&
    normalized.isEcho === true;

  if (isNativeEcho) {
    // First, recognise echoes of messages OUR platform sent through the Send API using the ids
    // we recorded at send time. This is essential on Instagram, whose echoes carry NO `app_id`
    // (so the `isHumanAgentEcho` heuristic below would classify every AI reply as a human
    // handoff) and whose reply-with-image turns echo back BEFORE the AI reply job has persisted
    // its outbound row (so the `external_message_id` dedup upstream can't catch them yet). A
    // self-sent echo must NEVER set a human-override hold or flip the conversation to human-owned.
    if (await wasSelfSentMessageEcho(normalized.externalMessageId)) {
      const isImageEcho =
        permanentAttachmentUrls.length > 0 || resolvedInboundMessageType !== 'text';
      if (isImageEcho) {
        // Auto-sent product images are not persisted anywhere else, so store this one exactly
        // once — attributed to the AI — so it still appears in the conversation thread.
        const aiImageEcho = await createMessage({
          tenant_id: channel.tenant_id,
          conversation_id: conversation.id,
          external_message_id: normalized.externalMessageId,
          direction: 'outbound',
          type: resolvedInboundMessageType,
          content: normalized.content,
          attachment_urls: permanentAttachmentUrls,
          sent_by: 'ai',
        });
        await touchConversationLastMessageAt(conversation.id);
        void logEvent(channel.tenant_id, 'ai_reply_echo', {
          conversation_id: conversation.id,
          channel_id: channel.id,
          channel_type: channel.type,
          message_id: aiImageEcho.id,
          source: 'self_send_image',
        });
        socketService.emitNewMessage(channel.tenant_id, aiImageEcho);
        socketService.emitConversationUpdated(channel.tenant_id, conversation.id);
      } else {
        // Text replies are persisted by the AI reply job itself; skip the echo to avoid a
        // duplicate-key clash on external_message_id.
        console.info('[inbound] Skipping self-sent text echo (persisted by AI reply job)', {
          conversation_id: conversation.id,
          external_message_id: normalized.externalMessageId,
        });
      }
      return;
    }

    // Meta echoes EVERY message the Page sends — including the AI's own Send-API replies and
    // replies we sent from our inbox UI (both call the Send API and carry an `app_id`). Only
    // echoes WITHOUT an `app_id` originate from a human agent typing in Meta's native surfaces
    // (Page Inbox, Business Suite, Messenger/Instagram app); that is the sole case that should
    // count as a human handoff and pause the AI. Treating API echoes as human replies is what
    // previously forced conversations into Human On Hold immediately after a normal AI reply.
    const humanAgentReply = isHumanAgentEcho(normalized.echoAppId);

    if (!humanAgentReply) {
      // API-originated echo (our AI / our inbox UI). The original outbound was already persisted
      // when we sent it; the top-level `external_message_id` dedup catches the echo when its
      // `mid` matches the id we recorded. When the `mid` differs we land here, so guard against a
      // duplicate row by matching the content of a message we just sent. Critically, we must NOT
      // mark a human reply, set a human-override hold, or otherwise change conversation ownership.
      const alreadyStored = await findRecentOutboundMessageByContent(
        conversation.id,
        channel.tenant_id,
        normalized.content,
        ECHO_DEDUP_WINDOW_MS,
      );

      if (alreadyStored) {
        console.info('[inbound] Skipping API-origin echo of an already-stored outbound message', {
          conversation_id: conversation.id,
          external_message_id: normalized.externalMessageId,
          echo_app_id: normalized.echoAppId,
        });
        return;
      }

      const aiEcho = await createMessage({
        tenant_id: channel.tenant_id,
        conversation_id: conversation.id,
        external_message_id: normalized.externalMessageId,
        direction: 'outbound',
        type: resolvedInboundMessageType,
        content: normalized.content,
        attachment_urls: permanentAttachmentUrls,
        sent_by: 'ai',
      });

      await touchConversationLastMessageAt(conversation.id);

      void logEvent(channel.tenant_id, 'ai_reply_echo', {
        conversation_id: conversation.id,
        channel_id: channel.id,
        channel_type: channel.type,
        message_id: aiEcho.id,
        echo_app_id: normalized.echoAppId,
      });

      socketService.emitNewMessage(channel.tenant_id, aiEcho);
      socketService.emitConversationUpdated(channel.tenant_id, conversation.id);
      return;
    }

    await markConversationHumanReplied(conversation.id, channel.tenant_id);

    const outboundMessage = await createMessage({
      tenant_id: channel.tenant_id,
      conversation_id: conversation.id,
      external_message_id: normalized.externalMessageId,
      direction: 'outbound',
      type: resolvedInboundMessageType,
      content: normalized.content,
      attachment_urls: permanentAttachmentUrls,
      sent_by: 'human',
    });

    await setHumanOverrideHold(conversation.id, channel.tenant_id);
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
    type: resolvedInboundMessageType,
    content: normalized.content,
    attachment_urls: permanentAttachmentUrls,
    sent_by: 'customer',
  });

  let inboundForSocket = inboundMessage;
  let replyToPayload: MessageReplyToPayload | undefined;
  if (normalized.replyToExternalId) {
    const original = await findMessageByExternalMessageIdForTenant(
      channel.tenant_id,
      normalized.replyToExternalId,
    );
    if (original) {
      const snap = buildReplySnapshotFromMessage(original);
      await updateMessageReplyResolved(inboundMessage.id, channel.tenant_id, {
        reply_to_message_id: original.id,
        reply_to_content: snap.reply_to_content,
        reply_to_attachment_url: snap.reply_to_attachment_url,
      });
      replyToPayload = messageToReplyToPayload(original);
    } else {
      await updateMessageReplyExternalOnly(
        inboundMessage.id,
        channel.tenant_id,
        normalized.replyToExternalId,
      );
    }
    const refreshed = await findMessageByIdForTenant(inboundMessage.id, channel.tenant_id);
    if (refreshed) {
      inboundForSocket = refreshed;
    }
  }

  await touchConversationLastMessageAt(conversation.id);

  void logEvent(channel.tenant_id, 'message_received', {
    conversation_id: conversation.id,
    channel_id: channel.id,
    channel_type: channel.type,
    message_id: inboundMessage.id,
  });

  socketService.emitNewMessage(channel.tenant_id, inboundForSocket, replyToPayload);
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
      // Carry the originating webhook's traceId so processAIReply can log it.
      traceId: (data as { traceId?: string }).traceId,
    }, {
      delay: Number.isFinite(aiReplyDelayMs) ? aiReplyDelayMs : 8000,
    });
  }
}
