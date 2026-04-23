import crypto from 'crypto';
import type { Request, Response } from 'express';
import { sendError } from '../utils/response';
import { webhookQueue } from '../jobs/queues';
import { redisConnection } from '../jobs/redisConnection';
import type { ChannelType } from '../db/models/channel';

const allowedTypes: ChannelType[] = ['facebook', 'instagram', 'whatsapp'];

function timingSafeCompare(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function isValidChannelType(value: string): value is ChannelType {
  return allowedTypes.includes(value as ChannelType);
}

function getWebhookAppSecret(channelType: ChannelType): string | null {
  if (channelType === 'instagram') {
    return process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || null;
  }

  if (channelType === 'facebook') {
    return process.env.META_APP_SECRET || null;
  }

  return process.env.META_APP_SECRET || null;
}

function isWebhookDebug(): boolean {
  const v = process.env.WEBHOOK_DEBUG?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

const WEBHOOK_TS_MAX_SKEW_MS = 300_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Meta timestamps are usually ms; some payloads use seconds. */
function parseMetaEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.trim());
    if (Number.isFinite(n) && n > 0) {
      return n < 1_000_000_000_000 ? n * 1000 : n;
    }
  }
  return null;
}

/** First messaging / WhatsApp message timestamp found in the body; null if none. */
function extractWebhookPayloadTimestampMs(payload: Record<string, unknown>): number | null {
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    if (Array.isArray(entry.messaging)) {
      for (const rawMsg of entry.messaging) {
        const item = asRecord(rawMsg);
        if (!item) continue;
        const ts = parseMetaEpochMs(item.timestamp);
        if (ts !== null) return ts;
      }
    }
    if (Array.isArray(entry.changes)) {
      for (const rawCh of entry.changes) {
        const change = asRecord(rawCh);
        const value = change ? asRecord(change.value) : null;
        if (!value || !Array.isArray(value.messages)) continue;
        for (const rawInner of value.messages) {
          const msg = asRecord(rawInner);
          if (!msg) continue;
          const ts = parseMetaEpochMs(msg.timestamp);
          if (ts !== null) return ts;
        }
      }
    }
  }
  return null;
}

function pickMessageMidOrId(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  if (typeof message.mid === 'string' && message.mid.trim()) return message.mid.trim();
  if (typeof message.id === 'string' && message.id.trim()) return message.id.trim();
  if (typeof message.id === 'number' && Number.isFinite(message.id) && message.id > 0) {
    return String(Math.trunc(message.id));
  }
  return null;
}

/**
 * Stable id for Redis dedupe: Meta message mids/ids when present, else a hash of the raw body.
 * X-Hub-Signature-256 does not embed a timestamp; body-only extraction is required before fallback.
 */
function extractWebhookMessageIdForDedupe(payload: Record<string, unknown>, rawBody: Buffer): string {
  const parts: string[] = [];
  const entries = Array.isArray(payload.entry) ? payload.entry : [];
  for (const rawEntry of entries) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    if (Array.isArray(entry.messaging)) {
      for (const rawMsg of entry.messaging) {
        const item = asRecord(rawMsg);
        if (!item) continue;
        const fromMessage = pickMessageMidOrId(asRecord(item.message));
        if (fromMessage) {
          parts.push(fromMessage);
          continue;
        }
        const reaction = asRecord(item.reaction);
        if (reaction) {
          const rmid = typeof reaction.mid === 'string' && reaction.mid.trim() ? reaction.mid.trim() : '';
          const ts = item.timestamp != null && item.timestamp !== '' ? String(item.timestamp) : '';
          parts.push(rmid ? `reaction:${rmid}:${ts}` : `reaction:${ts}`);
        }
      }
    }
    if (Array.isArray(entry.changes)) {
      for (const rawCh of entry.changes) {
        const change = asRecord(rawCh);
        const value = change ? asRecord(change.value) : null;
        if (!value || !Array.isArray(value.messages)) continue;
        for (const rawInner of value.messages) {
          const id = pickMessageMidOrId(asRecord(rawInner));
          if (id) parts.push(id);
        }
      }
    }
  }
  if (parts.length > 0) return parts.join('|');
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

function summarizeInstagramWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const entry = Array.isArray(payload.entry)
    ? (payload.entry[0] as Record<string, unknown> | undefined)
    : undefined;
  const changes =
    entry && Array.isArray(entry.changes)
      ? (entry.changes[0] as Record<string, unknown> | undefined)
      : undefined;
  const value =
    changes && changes.value && typeof changes.value === 'object' && !Array.isArray(changes.value)
      ? (changes.value as Record<string, unknown>)
      : undefined;
  const messaging0 =
    entry && Array.isArray(entry.messaging)
      ? (entry.messaging[0] as Record<string, unknown> | undefined)
      : undefined;

  const recipient = value?.recipient ?? messaging0?.recipient;
  const sender = value?.sender ?? messaging0?.sender;
  const recObj = recipient && typeof recipient === 'object' && !Array.isArray(recipient) ? recipient as { id?: unknown } : null;
  const sendObj = sender && typeof sender === 'object' && !Array.isArray(sender) ? sender as { id?: unknown } : null;

  return {
    object: typeof payload.object === 'string' ? payload.object : null,
    topKeys: Object.keys(payload),
    entryId: entry?.id ?? null,
    hasMessaging: Boolean(entry && Array.isArray(entry.messaging) && entry.messaging.length > 0),
    changeField: typeof changes?.field === 'string' ? changes.field : null,
    valueKeys: value ? Object.keys(value).slice(0, 24) : null,
    recipientId: recObj?.id ?? null,
    senderId: sendObj?.id ?? null,
  };
}

/** Ingest channel webhooks. Native Messenger/Instagram echoes need the `message_echoes` field on Page and Instagram webhook subscriptions. */
export async function ingestWebhook(req: Request, res: Response): Promise<void> {
  const channelTypeValue = req.params.channelType;
  const channelTypeParam = Array.isArray(channelTypeValue)
    ? channelTypeValue[0]
    : channelTypeValue;
  if (!isValidChannelType(channelTypeParam)) {
    sendError(res, 'Unsupported channel type', 400);
    return;
  }

  const parsedPayload =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  const enqueueInboundPayload = async (): Promise<void> => {
    try {
      await webhookQueue.add('message.inbound', {
        channelType: channelTypeParam,
        payload: parsedPayload,
      });
    } catch (err) {
      console.error('[webhook] failed to enqueue inbound payload', err);
    }
  };

  const appSecret = getWebhookAppSecret(channelTypeParam);
  if (!appSecret) {
    sendError(res, `Webhook app secret is not configured for ${channelTypeParam}`, 500);
    return;
  }

  const signatureHeader = req.header('X-Hub-Signature-256');
  if (!signatureHeader) {
    if (isWebhookDebug()) {
      console.warn('[webhook] rejected: missing X-Hub-Signature-256', { channelType: channelTypeParam });
    }
    res.sendStatus(403);
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    sendError(res, 'Missing raw webhook body', 400);
    return;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex')}`;

  if (!timingSafeCompare(signatureHeader, expectedSignature)) {
    if (isWebhookDebug()) {
      console.warn('[webhook] rejected: signature mismatch', { channelType: channelTypeParam });
    }
    res.sendStatus(403);
    return;
  }

  const payloadTsMs = extractWebhookPayloadTimestampMs(parsedPayload);
  const eventEpochMs = payloadTsMs ?? Date.now();
  if (Math.abs(Date.now() - eventEpochMs) > WEBHOOK_TS_MAX_SKEW_MS) {
    res.status(403).json({ error: 'Webhook timestamp out of acceptable range' });
    return;
  }

  const messageId = extractWebhookMessageIdForDedupe(parsedPayload, rawBody);
  const seenKey = `webhook_seen:${messageId}`;
  const dedupeSet = await redisConnection.set(seenKey, '1', 'EX', 86400, 'NX');
  if (dedupeSet !== 'OK') {
    res.sendStatus(200);
    return;
  }

  const entry = Array.isArray(parsedPayload.entry)
    ? (parsedPayload.entry[0] as Record<string, unknown> | undefined)
    : undefined;
  const webhookObject =
    typeof parsedPayload.object === 'string' ? parsedPayload.object : 'unknown';
  const entryId =
    typeof entry?.id === 'string' || typeof entry?.id === 'number' ? String(entry.id) : 'unknown';

  console.info('[webhook] verified inbound', {
    channelType: channelTypeParam,
    object: webhookObject,
    entryId,
  });

  if (isWebhookDebug() && channelTypeParam === 'instagram') {
    console.info('[webhook][debug] instagram payload digest', summarizeInstagramWebhookPayload(parsedPayload));
  }

  res.sendStatus(200);
  void enqueueInboundPayload();
}
