import axios from 'axios';
import crypto from 'crypto';
import path from 'path';
import {
  findChannelByTypeAndExternalId,
  resolveChannelByTypeAndExternalId,
  type ChannelType,
} from '../db/models/channel';
import { findContactByExternalIdForTenantChannel, upsertContact } from '../db/models/contact';
import {
  findConversationByIdForTenant,
  upsertConversation,
  touchConversationLastMessageAt,
  markConversationHumanReplied,
} from '../db/models/conversation';
import {
  applyMessageEdit,
  createMessage,
  createMessageTx,
  existsOutboundAfter,
  findMessageByExternalMessageIdForTenant,
  findMessageByIdForTenant,
  findMessageIdByExternalMessageId,
  findMessageIdByTenantAndExternalMessageId,
  findRecentOutboundMessageByContent,
  buildReplySnapshotFromMessage,
  updateMessageReplyExternalOnly,
  updateMessageReplyResolved,
} from '../db/models/message';
import {
  aiReplyDedupeKey,
  hasLiveAiReply,
  upsertLiveAiReplyTx,
} from '../db/models/outbox';
import pool from '../db/pool';
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
import { lookupSelfSentMessageEcho } from '../services/outboundEchoRegistry';
import {
  canCorroborateEchoContent,
  shouldClassifyEchoAsHuman,
} from '../services/echoDurableCorroboration';
import { cryptoService } from '../services/cryptoService';
import { socketService } from '../services/socketService';
import { uploadImage } from '../services/cloudinaryService';
import { uploadFile } from '../services/backblazeService';
import { aiQueue } from './queues';
import { logEvent } from '../services/analyticsService';
import { reportChannelBindingConflict } from '../services/channelIsolationService';
import { findAIConfigGateStateByTenant } from '../db/models/aiConfig';
import { aiConfigVersion } from '../services/aiConfigCache';
import { buildReceiptSnapshot, type ReceiptSnapshot } from '../services/receiptSnapshot';
import { buildAIReplyJobData, type InboundWebhookJobData } from './jobTypes';

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

/**
 * P0-7 (RC-24): when true, a native IG/FB echo with no `app_id` (which the `isHumanAgentEcho`
 * heuristic would treat as a human handoff) is corroborated against a recently-persisted
 * outbound we sent before being classified as a human reply, and a self-send registry READ
 * ERROR is logged distinctly. This stops the AI's own Instagram reply — on a self-send registry
 * miss — from setting the sticky `human_replied` flag (which disqualifies the use-case fee), a
 * 10-minute human hold, and a phantom `sent_by:'human'` row. Fails toward "not human".
 * Defaults OFF: flag-off preserves the legacy app_id-only classification byte-for-byte. Flip
 * per environment (staging first) per the remediation plan.
 */
const ECHO_DURABLE_CORROBORATION =
  (process.env.ECHO_DURABLE_CORROBORATION ?? 'false').trim().toLowerCase() === 'true';

/**
 * How far back the P0-7 human-branch corroboration looks for a matching outbound we sent.
 * Deliberately tighter than `ECHO_DEDUP_WINDOW_MS` (5 min): echoes arrive within seconds, so a
 * tight window shrinks the chance a genuine human reply coincidentally equals a recent outbound.
 */
const ECHO_HUMAN_CORROBORATION_WINDOW_MS = 60 * 1000;

/**
 * P1-1 (RC-21): when true, the inbound message persist and the ai.reply enqueue-intent are
 * written in ONE Postgres transaction (message row + a live `ai.reply` transactional_outbox row),
 * and the outbox relay drains the intent to BullMQ. A crash between the persist and the enqueue
 * can no longer lose the reply job — on retry the dedupe re-check finds no live intent and
 * re-inserts one, instead of the legacy bare early-return that silently dropped the turn forever.
 * The racy getJobs→remove→add debounce is replaced by the single-live-intent upsert.
 * Defaults OFF: flag-off keeps the legacy persist-then-`aiQueue.add` path byte-for-byte. In
 * shadow (relay not dispatching) the legacy direct add still runs, so no double job. Flip in
 * staging first.
 */
const INBOUND_OUTBOX_ENQUEUE =
  (process.env.INBOUND_OUTBOX_ENQUEUE ?? 'false').trim().toLowerCase() === 'true';

/**
 * P1-1: whether the outbox relay is DISPATCHING (not just shadow-draining). Read here so the
 * inbound path knows whether the relay will deliver the ai.reply intent. Shadow (dispatch off):
 * write the outbox intent AND keep the legacy direct `aiQueue.add` so delivery continues while the
 * relay plumbing is validated. Dispatch on: the relay owns delivery, so the inbound path drops the
 * direct add (no double job). Mirrors the flag in `jobs/outboxRelay.ts`.
 */
const OUTBOX_DISPATCH_ENABLED =
  (process.env.OUTBOX_DISPATCH_ENABLED ?? 'false').trim().toLowerCase() === 'true';

/**
 * P1-1 (RC-20): when true, inbound deduplication reads the tenant-scoped
 * `idx_messages_tenant_external` index instead of the global one, so two tenants can legitimately
 * carry the same channel `external_message_id` (closes the C-114 cross-tenant dedupe leak).
 * Defaults OFF: flag-off keeps the legacy global lookup. Requires migration 071 (landed).
 */
const MESSAGES_SCOPED_UNIQUE_READ =
  (process.env.MESSAGES_SCOPED_UNIQUE_READ ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-4 Part 2 (RC-06): capture the enablement/config state at RECEIPT into the ai.reply payload.
 *
 * This function — not the webhook controller — is the receipt boundary that matters, because the
 * DELIBERATE deferral is added HERE (`AI_REPLY_DELAY_MS`, default 8s, on both enqueue paths). The
 * webhookQueue hop before it carries no delay. RC-06's mechanism is literally "received → queued
 * with 8s delay (+fairness/lock/hold reschedules)", all of which is downstream of this point.
 * The controller also cannot capture: `upsertConversation` below is what CREATES the conversation
 * row, so at controller time `ai_paused` does not yet exist to read.
 *
 * RECORD-ONLY (see services/receiptSnapshot.ts for why governing the gates is unsafe). Defaults
 * OFF: flag-off skips the capture read entirely, so it costs zero.
 */
const RECEIPT_TIME_SNAPSHOT =
  (process.env.RECEIPT_TIME_SNAPSHOT ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-4 Part 2 (RC-06): the impure half of the receipt-time snapshot — load what the pure
 * `buildReceiptSnapshot` needs. Returns undefined when the flag is off (zero cost) or when any
 * read fails: an absent snapshot is a first-class case that every consumer treats as "fall back to
 * live, record nothing", so capture must NEVER be able to fail an inbound message.
 *
 * Cost is honest, not free: `channel.ai_enabled` / `conversation.ai_paused` / `human_override_until`
 * are already in memory on the hot path, so it is +1 narrow SELECT (the ai_config gate state). The
 * two cold paths (edit, RC-21 recovery) hold only a conversation id, so they pay +2 — acceptable
 * given both are rare/recovery-only.
 */
async function captureReceiptSnapshot(args: {
  tenantId: string;
  channelAiEnabled: boolean;
  matchCount: number | null;
  receivedAtMs: number | null;
  conversation?: { ai_paused: boolean; human_override_until?: Date | null };
  conversationId?: string;
}): Promise<ReceiptSnapshot | undefined> {
  if (!RECEIPT_TIME_SNAPSHOT) return undefined;
  try {
    const conversation =
      args.conversation ??
      (args.conversationId
        ? await findConversationByIdForTenant(args.conversationId, args.tenantId)
        : null);
    if (!conversation) return undefined;

    const gate = await findAIConfigGateStateByTenant(args.tenantId);
    return buildReceiptSnapshot({
      nowMs: Date.now(),
      receivedAtMs: args.receivedAtMs,
      // No ai_config row means the tenant has no AI configured — the gate reads falsy either way.
      aiActive: gate?.is_active ?? false,
      aiConfigVersion: aiConfigVersion(gate?.updated_at ?? null),
      channelAiEnabled: args.channelAiEnabled,
      conversationAiPaused: conversation.ai_paused,
      humanOverrideUntil: conversation.human_override_until ?? null,
      matchCount: args.matchCount,
    });
  } catch (err) {
    // Telemetry must never break delivery. Absent snapshot → the job runs on live reads as always.
    console.warn('[inbound] receipt snapshot capture failed (ignored)', {
      tenantId: args.tenantId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

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
async function processInboundEdit(
  edit: InboundEditDTO,
  jobContext: { traceId?: string; receivedAtMs?: number } = {},
): Promise<void> {
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
  // P2-4 Part 2 (RC-11 prerequisite): match the message too, not just the conversation. Matching on
  // conversationId ALONE removes whatever ai.reply happens to be pending — including one belonging
  // to a NEWER, unrelated turn — and replaces it with a job keyed to this older message. That is a
  // turn-cancellation primitive reachable from a replayed edit body, and the skew gate we are
  // removing was the only thing bounding it.
  const existingJob = pendingAiReplyJobs.find(
    (job) =>
      job.name === 'ai.reply' &&
      job.data?.conversationId === existing.conversation_id &&
      job.data?.messageExternalId === existing.external_message_id,
  );
  if (existingJob) {
    await existingJob.remove();
  }
  await aiQueue.add(
    'ai.reply',
    buildAIReplyJobData({
      tenantId: channel.tenant_id,
      channelId: channel.id,
      conversationId: existing.conversation_id,
      messageExternalId: existing.external_message_id,
      // P2-4 Part 2: the edit path never carried the correlation id — a pre-existing drift the
      // shared factory now makes structural rather than per-site discipline.
      traceId: jobContext.traceId,
      receiptSnapshot: await captureReceiptSnapshot({
        tenantId: channel.tenant_id,
        channelAiEnabled: channel.ai_enabled,
        // Cold path: no conversation row in scope, so the snapshot pays a second read.
        conversationId: existing.conversation_id,
        // Genuinely unobservable here — findChannelByTypeAndExternalId collapses the count. null,
        // not 1: this is the field that exists to reveal a dual binding, so guessing defeats it.
        matchCount: null,
        receivedAtMs: jobContext.receivedAtMs ?? null,
      }),
    }),
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
    await processInboundEdit(event, {
      traceId: data.traceId,
      receivedAtMs: data.receivedAtMs,
    });
    return;
  }
  const normalized: InboundMessageDTO = event;

  // Legacy inbound dedupe (flags off): a GLOBAL external-id match short-circuits before channel
  // resolution. Under the P1-1 flags the dedupe moves BELOW channel resolution so it is
  // tenant-scoped (RC-20 / C-114) and can re-check the live ai.reply intent on a duplicate (RC-21).
  if (!MESSAGES_SCOPED_UNIQUE_READ && !INBOUND_OUTBOX_ENQUEUE) {
    const existingId = await findMessageIdByExternalMessageId(normalized.externalMessageId);
    if (existingId) {
      console.info('[inbound] Duplicate external_message_id, skipping processing', {
        external_message_id: normalized.externalMessageId,
        message_id: existingId,
      });
      return;
    }
  }

  const { channel, matchCount, tenantIds } = await resolveChannelByTypeAndExternalId(
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

  // P1-7 (RC-09 / SEC-2): if this (type, external_id) is bound to more than one tenant we routed to
  // the earliest (deterministic) binding above; surface the collision best-effort so ops/tenants can
  // resolve the dual-connect. At most one row exists once migration 075's global UNIQUE is enforced.
  if (matchCount > 1) {
    await reportChannelBindingConflict({
      type: normalized.channelType,
      externalId: normalized.channelExternalId,
      matchCount,
      tenantIds,
      resolvedTenantId: channel.tenant_id,
    }).catch(() => undefined);
  }

  // P1-1 tenant-scoped dedupe + RC-21 live-intent re-check (runs once the tenant is known).
  if (MESSAGES_SCOPED_UNIQUE_READ || INBOUND_OUTBOX_ENQUEUE) {
    const existingId = await findMessageIdByTenantAndExternalMessageId(
      channel.tenant_id,
      normalized.externalMessageId,
    );
    if (existingId) {
      const existing = await findMessageByIdForTenant(existingId, channel.tenant_id);
      // Under the outbox path, a lost enqueue must self-heal: if the message expects an AI reply,
      // has not already been answered, and has no live ai.reply intent, re-insert the intent
      // instead of the legacy bare early-return that dropped the turn forever (RC-21). The primary
      // RC-21 fix is the atomic persist+intent below; this is the recovery net for a Meta
      // redelivery of a turn whose intent was somehow lost.
      if (
        INBOUND_OUTBOX_ENQUEUE &&
        existing &&
        normalized.skipAiReply !== true &&
        !(await existsOutboundAfter(existing.conversation_id, channel.tenant_id, existing.created_at)) &&
        !(await hasLiveAiReply(existing.conversation_id))
      ) {
        // Capture BEFORE `pool.connect()`. The snapshot's reads take their own client from the
        // same pool, so running them inside the transaction below would hold one client while
        // waiting for another — with PG_POOL_MAX and WEBHOOK_WORKER_CONCURRENCY both defaulting
        // to 10, enough concurrent recoveries would each hold a client and wait forever.
        const recoverySnapshot = await captureReceiptSnapshot({
          tenantId: channel.tenant_id,
          channelAiEnabled: channel.ai_enabled,
          // Cold path: recovery only, no conversation row in scope → +2 reads, acceptable.
          conversationId: existing.conversation_id,
          matchCount,
          receivedAtMs: data.receivedAtMs ?? null,
        });
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await upsertLiveAiReplyTx(client, {
            tenant_id: channel.tenant_id,
            conversation_id: existing.conversation_id,
            dedupe_key: aiReplyDedupeKey(existing.conversation_id, normalized.externalMessageId),
            // P2-4 Part 2: `payload` is Record<string, unknown>, so this literal is NOT type-checked
            // against AIReplyJobData — the factory is what keeps it in contract.
            payload: buildAIReplyJobData({
              tenantId: channel.tenant_id,
              channelId: channel.id,
              conversationId: existing.conversation_id,
              messageExternalId: normalized.externalMessageId,
              traceId: data.traceId,
              receiptSnapshot: recoverySnapshot,
            }) as unknown as Record<string, unknown>,
            available_at: new Date(),
          });
          await client.query('COMMIT');
          console.warn('[inbound] Re-enqueued missing ai.reply intent for a persisted message (RC-21 recovery)', {
            conversationId: existing.conversation_id,
            external_message_id: normalized.externalMessageId,
          });
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          console.error('[inbound] Failed to re-enqueue ai.reply intent', {
            external_message_id: normalized.externalMessageId,
            err,
          });
        } finally {
          client.release();
        }
      } else {
        console.info('[inbound] Duplicate external_message_id, skipping processing', {
          external_message_id: normalized.externalMessageId,
          message_id: existingId,
        });
      }
      return;
    }
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

  // P2-4 Part 2 (RC-06): capture HERE — the first point tenant + channel + conversation + config
  // are all resolvable, and BEFORE the attachment download/re-upload below, which can burn seconds
  // on media turns and would otherwise age the "receipt" state before it is even read.
  // `channel.ai_enabled` and the conversation's pause/hold are already in memory (free); only the
  // ai_config gate state costs a read, and only when the flag is on.
  const receiptSnapshot = await captureReceiptSnapshot({
    tenantId: channel.tenant_id,
    channelAiEnabled: channel.ai_enabled,
    conversation,
    matchCount,
    receivedAtMs: data.receivedAtMs ?? null,
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
    const selfEchoLookup = await lookupSelfSentMessageEcho(normalized.externalMessageId);
    if (ECHO_DURABLE_CORROBORATION && selfEchoLookup === 'error') {
      // Surface the Redis failure that would otherwise silently let this echo fall through to
      // the human-agent branch below; content corroboration there still guards the outcome.
      console.warn('[inbound] self-send echo registry read errored; will corroborate by content', {
        conversation_id: conversation.id,
        external_message_id: normalized.externalMessageId,
      });
    }
    if (selfEchoLookup === 'self') {
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

    // P0-7 (RC-24): before recording a human handoff, corroborate this no-`app_id` echo against
    // durable state. On Instagram the AI's own reply echoes back with no `app_id`, so the
    // `isHumanAgentEcho` heuristic above always lands here; a content match against a recent
    // outbound we sent proves the echo is ours and must NOT set `human_replied` / a hold / a
    // phantom `sent_by:'human'` row. Flag OFF skips the query and always proceeds (byte-for-byte).
    // Content-less echoes (pure images) never corroborate: the NULL-safe lookup would match any
    // recent NULL-content outbound (e.g. an AI image echo row) and suppress+drop a genuine
    // human image reply — see canCorroborateEchoContent.
    const contentMatchesRecentOutbound =
      ECHO_DURABLE_CORROBORATION && canCorroborateEchoContent(normalized.content)
        ? (await findRecentOutboundMessageByContent(
            conversation.id,
            channel.tenant_id,
            normalized.content,
            ECHO_HUMAN_CORROBORATION_WINDOW_MS,
          )) != null
        : false;

    if (
      !shouldClassifyEchoAsHuman({
        durableCorroborationEnabled: ECHO_DURABLE_CORROBORATION,
        contentMatchesRecentOutbound,
      })
    ) {
      console.info('[inbound] Native echo corroborated as self-sent by content; not a human reply', {
        conversation_id: conversation.id,
        external_message_id: normalized.externalMessageId,
        echo_app_id: normalized.echoAppId,
      });
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

  // Persist the inbound message. P1-1 (RC-21): when the outbox path is on, persist the message row
  // AND the live ai.reply enqueue-intent in ONE transaction, so a crash between them cannot lose
  // the reply job. The `idx_outbox_live_ai_reply` upsert also replaces the racy getJobs→remove→add
  // debounce: a burst collapses to a single live intent pointing at the latest inbound.
  let inboundMessage;
  if (INBOUND_OUTBOX_ENQUEUE) {
    const aiReplyDelayMs = Number(process.env.AI_REPLY_DELAY_MS ?? '8000');
    const delayMs = Number.isFinite(aiReplyDelayMs) ? aiReplyDelayMs : 8000;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      inboundMessage = await createMessageTx(client, {
        tenant_id: channel.tenant_id,
        conversation_id: conversation.id,
        external_message_id: normalized.externalMessageId,
        direction: 'inbound',
        type: resolvedInboundMessageType,
        content: normalized.content,
        attachment_urls: permanentAttachmentUrls,
        sent_by: 'customer',
      });
      if (normalized.skipAiReply !== true) {
        await upsertLiveAiReplyTx(client, {
          tenant_id: channel.tenant_id,
          conversation_id: conversation.id,
          dedupe_key: aiReplyDedupeKey(conversation.id, normalized.externalMessageId),
          // P2-4 Part 2: `payload` is Record<string, unknown> and the relay re-hydrates it through
          // an `unknown` cast, so neither end type-checks this. Once the outbox owns delivery this
          // is the ONLY live producer — the factory is what keeps it in contract.
          payload: buildAIReplyJobData({
            tenantId: channel.tenant_id,
            channelId: channel.id,
            conversationId: conversation.id,
            messageExternalId: normalized.externalMessageId,
            traceId: data.traceId,
            receiptSnapshot,
          }) as unknown as Record<string, unknown>,
          // Debounce: the intent becomes eligible to drain AI_REPLY_DELAY_MS after this inbound.
          available_at: new Date(Date.now() + delayMs),
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      throw err;
    }
    client.release();
  } else {
    inboundMessage = await createMessage({
      tenant_id: channel.tenant_id,
      conversation_id: conversation.id,
      external_message_id: normalized.externalMessageId,
      direction: 'inbound',
      type: resolvedInboundMessageType,
      content: normalized.content,
      attachment_urls: permanentAttachmentUrls,
      sent_by: 'customer',
    });
  }

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

  // Legacy direct enqueue + debounce. Skipped only when the outbox relay OWNS delivery
  // (INBOUND_OUTBOX_ENQUEUE + dispatch on) — then the atomic intent above is the single source of
  // the job. In shadow (dispatch off) this still runs so delivery continues while the relay is
  // validated; the relay shadow-drains the intent without dispatching, so there is no double job.
  const outboxOwnsDelivery = INBOUND_OUTBOX_ENQUEUE && OUTBOX_DISPATCH_ENABLED;
  if (normalized.skipAiReply !== true && !outboxOwnsDelivery) {
    const aiReplyDelayMs = Number(process.env.AI_REPLY_DELAY_MS ?? '8000');
    const pendingAiReplyJobs = await aiQueue.getJobs(['delayed', 'waiting']);
    const existingJob = pendingAiReplyJobs.find(
      (job) => job.name === 'ai.reply' && job.data?.conversationId === conversation.id,
    );

    if (existingJob) {
      await existingJob.remove();
    }

    await aiQueue.add('ai.reply', buildAIReplyJobData({
      tenantId: channel.tenant_id,
      channelId: channel.id,
      conversationId: conversation.id,
      messageExternalId: normalized.externalMessageId,
      // Carry the originating webhook's traceId so processAIReply can log it.
      traceId: data.traceId,
      receiptSnapshot,
    }), {
      delay: Number.isFinite(aiReplyDelayMs) ? aiReplyDelayMs : 8000,
    });
  }
}
