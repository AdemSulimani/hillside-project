import crypto from 'crypto';
import type { Request, Response } from 'express';
import { sendError } from '../utils/response';
import { webhookQueue } from '../jobs/queues';
import { redisConnection } from '../jobs/redisConnection';
import { findChannelByTypeAndExternalId, updateChannel, type ChannelType } from '../db/models/channel';
import { deriveDedupeKey, shouldAcceptWebhookDelivery } from '../services/webhookDelivery';

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

/**
 * P2-4 Part 2 (RC-11): when true, drop the wall-clock freshness gate and rely on the layers that
 * actually distinguish a replay from a late delivery — HMAC (verified above this, unchanged), the
 * `webhook_seen` claim keyed per-message, and the durable DB dedupe in processInboundMessage.
 *
 * Requires its prerequisites, which ship alongside: the per-message dedupe key (`deriveDedupeKey`),
 * the `applyMessageEdit` monotonicity guard, and the message-scoped pending-job removal. Without
 * those, removing the 403 would open a durable content-rewrite + AI-turn-cancellation primitive.
 * Defaults OFF: flag-off keeps the legacy skew gate and legacy key byte-for-byte.
 */
const WEBHOOK_DEDUPE_REPLAY =
  (process.env.WEBHOOK_DEDUPE_REPLAY ?? 'false').trim().toLowerCase() === 'true';

/**
 * P1-1 (RC-21): when true, the webhook ACKs 200 only AFTER `webhookQueue.add` has committed the
 * inbound job, and releases the `webhook_seen` dedupe claim on enqueue failure so Meta's retry is
 * honored. This closes the legacy gap where the 200 was sent and the enqueue was a detached
 * `void` — a failed enqueue was only logged, the seen-claim stayed set for 24h, and the delivery
 * was lost forever. Defaults OFF: flag-off keeps the legacy ack-then-fire-and-forget. Flip in
 * staging first.
 */
const WEBHOOK_ACK_AFTER_ENQUEUE =
  (process.env.WEBHOOK_ACK_AFTER_ENQUEUE ?? 'false').trim().toLowerCase() === 'true';

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

function extractChannelExternalIdForVerification(
  channelType: ChannelType,
  payload: Record<string, unknown>,
): string | null {
  const entry = Array.isArray(payload.entry)
    ? (payload.entry[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!entry) return null;

  // Facebook and Instagram webhook entries use entry.id as the channel identifier.
  if (channelType === 'facebook' || channelType === 'instagram') {
    if (typeof entry.id === 'string' && entry.id.trim()) return entry.id.trim();
    if (typeof entry.id === 'number' && Number.isFinite(entry.id) && entry.id > 0) {
      return String(Math.trunc(entry.id));
    }
    return null;
  }

  // WhatsApp channel external_id is phone_number_id, not entry.id (which is usually WABA id).
  const changes = Array.isArray(entry.changes)
    ? (entry.changes[0] as Record<string, unknown> | undefined)
    : undefined;
  const value =
    changes && typeof changes.value === 'object' && !Array.isArray(changes.value)
      ? (changes.value as Record<string, unknown>)
      : undefined;
  const metadata =
    value && typeof value.metadata === 'object' && !Array.isArray(value.metadata)
      ? (value.metadata as Record<string, unknown>)
      : undefined;
  const phoneNumberId = metadata?.phone_number_id;

  if (typeof phoneNumberId === 'string' && phoneNumberId.trim()) return phoneNumberId.trim();
  if (typeof phoneNumberId === 'number' && Number.isFinite(phoneNumberId) && phoneNumberId > 0) {
    return String(Math.trunc(phoneNumberId));
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

  // P2-4 Part 2 (RC-06): stamp true receipt time at the earliest point, for the same reason and in
  // the same spirit as traceId. The snapshot itself is captured downstream (processInboundMessage
  // is where the conversation row first exists and where the deliberate 8s deferral is applied);
  // carrying this makes the gap between the two a measured number rather than an assumption.
  const receivedAtMs = Date.now();

  const enqueueInboundPayload = async (): Promise<void> => {
    // Generate a correlation ID here — at the earliest point in the pipeline —
    // so it can be forwarded through every downstream job and log line. A single
    // grep for this traceId reconstructs the full lifecycle of one message.
    const traceId = crypto.randomUUID();
    try {
      await webhookQueue.add('message.inbound', {
        channelType: channelTypeParam,
        payload: parsedPayload,
        traceId,
        receivedAtMs,
      });
    } catch (err) {
      console.error('[webhook] failed to enqueue inbound payload', { err, traceId });
      // P1-1 (RC-21): when acking after enqueue, surface the failure so the caller can release
      // the seen-claim and return 500 (Meta then retries). Legacy path keeps swallowing.
      if (WEBHOOK_ACK_AFTER_ENQUEUE) throw err;
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

  // A valid signature proves Meta can reach this webhook using the app secret.
  // Mark the matched channel as verified on first successful signed event.
  const externalId = extractChannelExternalIdForVerification(channelTypeParam, parsedPayload);
  if (externalId) {
    try {
      const matched = await findChannelByTypeAndExternalId(channelTypeParam, externalId);
      if (matched && !matched.webhook_verified) {
        await updateChannel(matched.id, matched.tenant_id, { webhook_verified: true });
      }
    } catch (err) {
      console.warn('[webhook] failed to update webhook verification status', {
        channelType: channelTypeParam,
        externalId,
        err,
      });
    }
  }

  // P2-4 Part 2 (RC-11): with WEBHOOK_DEDUPE_REPLAY on, accept late-but-valid deliveries and let
  // the dedupe key + the durable DB dedupe distinguish a replay from a late delivery — which is
  // the only thing that actually can. The skew gate could not: a payload with NO timestamp scored
  // |now-now|=0 and always passed however old, while a payload WITH an old timestamp was 403'd
  // forever (Meta redelivers the same stale timestamp), silently dropping valid customer messages.
  // It also 403s Meta's retry of a delivery WE asked to be retried via WEBHOOK_ACK_AFTER_ENQUEUE's
  // 500, defeating that RC-21 recovery. Signature verification above is unaffected and still first.
  const delivery = shouldAcceptWebhookDelivery({
    payloadTsMs: extractWebhookPayloadTimestampMs(parsedPayload),
    nowMs: Date.now(),
    dedupeReplayEnabled: WEBHOOK_DEDUPE_REPLAY,
  });
  if (!delivery.accept) {
    res.status(403).json({ error: 'Webhook timestamp out of acceptable range' });
    return;
  }

  const messageId = WEBHOOK_DEDUPE_REPLAY
    ? deriveDedupeKey(parsedPayload, rawBody)
    : extractWebhookMessageIdForDedupe(parsedPayload, rawBody);
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

  // P1-1 (RC-21): ack only after the inbound job is durably enqueued. On failure, release the
  // seen-claim so Meta's redelivery is honored instead of being deduped away for 24h.
  if (WEBHOOK_ACK_AFTER_ENQUEUE) {
    try {
      await enqueueInboundPayload();
      res.sendStatus(200);
    } catch (err) {
      await redisConnection.del(seenKey).catch(() => undefined);
      console.error('[webhook] enqueue failed after seen-claim — released claim, returning 500', {
        err,
      });
      res.sendStatus(500);
    }
    return;
  }

  res.sendStatus(200);
  void enqueueInboundPayload();
}
