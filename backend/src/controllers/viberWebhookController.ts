import crypto from 'crypto';
import type { Request, Response } from 'express';
import pool from '../db/pool';
import type { Channel } from '../db/models/channel';
import { updateChannel } from '../db/models/channel';
import { cryptoService } from '../services/cryptoService';
import { webhookQueue } from '../jobs/queues';
import { redisConnection } from '../jobs/redisConnection';

const WEBHOOK_TS_MAX_SKEW_MS = 300_000;

function isWebhookDebug(): boolean {
  const v = process.env.WEBHOOK_DEBUG?.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function timingSafeCompare(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/**
 * Viber sends `timestamp` as epoch milliseconds at the top level of all callback payloads.
 * Returns null when the field is absent or unparseable.
 */
function parseViberTimestampMs(payload: Record<string, unknown>): number | null {
  const ts = payload.timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    return ts < 1_000_000_000_000 ? ts * 1000 : ts;
  }
  return null;
}

/**
 * Extracts a stable deduplication key for a Viber payload.
 * Uses `message_token` when present (all Viber callback types include it),
 * falling back to a SHA-256 hash of the raw body.
 */
function extractViberDedupeKey(payload: Record<string, unknown>, rawBody: Buffer): string {
  const token = payload.message_token;
  if (token != null && token !== '') return `viber:${String(token)}`;
  return crypto.createHash('sha256').update(rawBody).digest('hex');
}

/** Look up a Viber channel by its DB UUID without requiring tenantId. */
async function findViberChannelById(channelId: string): Promise<Channel | null> {
  const { rows } = await pool.query<Channel>(
    "SELECT * FROM channels WHERE id = $1 AND type = 'viber' LIMIT 1",
    [channelId],
  );
  return rows[0] ?? null;
}

/**
 * Handles POST /api/webhooks/viber/:channelId
 *
 * Viber uses per-bot HMAC-SHA256 signatures (not a shared app secret like Meta).
 * The signature is delivered in X-Viber-Content-Signature as a hex string and is
 * computed as HMAC-SHA256(authToken, rawBody).
 *
 * Supported events:
 *   - webhook  → respond 200 + mark webhook_verified (Viber setup handshake)
 *   - message  → verify, dedupe, enqueue to BullMQ
 *   - subscribed / unsubscribed / conversation_started → respond 200 (no AI)
 *   - delivered / seen / failed → respond 200 (delivery receipts, no action)
 */
export async function ingestViberWebhook(req: Request, res: Response): Promise<void> {
  const { channelId } = req.params as { channelId: string };

  if (!channelId) {
    res.sendStatus(400);
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody) {
    res.sendStatus(400);
    return;
  }

  const parsedPayload =
    req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? (req.body as Record<string, unknown>)
      : {};

  const event = typeof parsedPayload.event === 'string' ? parsedPayload.event : '';

  // Viber's set_webhook verification callback — respond 200 immediately so Viber
  // considers the webhook URL valid, then mark the channel as verified.
  if (event === 'webhook') {
    res.sendStatus(200);

    try {
      const channel = await findViberChannelById(channelId);
      if (channel && !channel.webhook_verified) {
        await updateChannel(channelId, channel.tenant_id, { webhook_verified: true });
        console.info('[viber-webhook] webhook_verified set for channel', { channelId });
      }
    } catch (err) {
      console.warn('[viber-webhook] failed to mark webhook_verified', { channelId, err });
    }
    return;
  }

  // Delivery receipts and subscription events don't require AI processing.
  if (
    event === 'delivered' ||
    event === 'seen' ||
    event === 'failed' ||
    event === 'subscribed' ||
    event === 'unsubscribed' ||
    event === 'conversation_started'
  ) {
    res.sendStatus(200);
    return;
  }

  // For all other events (primarily 'message') verify the HMAC signature.
  const signatureHeader = req.header('X-Viber-Content-Signature');
  if (!signatureHeader) {
    if (isWebhookDebug()) {
      console.warn('[viber-webhook] rejected: missing X-Viber-Content-Signature', { channelId });
    }
    res.sendStatus(403);
    return;
  }

  // Look up the channel to get its auth token for signature verification.
  const channel = await findViberChannelById(channelId).catch((err) => {
    console.error('[viber-webhook] DB lookup failed', { channelId, err });
    return null;
  });

  if (!channel) {
    if (isWebhookDebug()) {
      console.warn('[viber-webhook] channel not found', { channelId });
    }
    res.sendStatus(404);
    return;
  }

  // Verify HMAC-SHA256(authToken, rawBody) against X-Viber-Content-Signature.
  let authToken: string;
  try {
    authToken = cryptoService.decrypt(channel.access_token_encrypted);
  } catch (err) {
    console.error('[viber-webhook] failed to decrypt channel token', { channelId, err });
    res.sendStatus(500);
    return;
  }

  const expectedSig = crypto
    .createHmac('sha256', authToken)
    .update(rawBody)
    .digest('hex');

  if (!timingSafeCompare(signatureHeader, expectedSig)) {
    if (isWebhookDebug()) {
      console.warn('[viber-webhook] rejected: signature mismatch', { channelId });
    }
    res.sendStatus(403);
    return;
  }

  // Freshness check using Viber's top-level timestamp (milliseconds).
  const eventTsMs = parseViberTimestampMs(parsedPayload) ?? Date.now();
  if (Math.abs(Date.now() - eventTsMs) > WEBHOOK_TS_MAX_SKEW_MS) {
    res.status(403).json({ error: 'Webhook timestamp out of acceptable range' });
    return;
  }

  // Redis-based idempotency guard using message_token.
  const dedupeKey = `webhook_seen:${extractViberDedupeKey(parsedPayload, rawBody)}`;
  const dedupeResult = await redisConnection.set(dedupeKey, '1', 'EX', 86400, 'NX');
  if (dedupeResult !== 'OK') {
    res.sendStatus(200);
    return;
  }

  // Respond immediately; enqueue downstream in the background.
  res.sendStatus(200);

  const traceId = crypto.randomUUID();
  try {
    // Attach the bot's external_id into the payload so the normalizer can resolve the channel
    // without an additional DB round-trip. Viber payloads don't include the bot's own id,
    // so we embed it from the channel row retrieved above.
    const enrichedPayload = {
      ...parsedPayload,
      _viber_channel_external_id: channel.external_id,
    };

    await webhookQueue.add('message.inbound', {
      channelType: 'viber',
      payload: enrichedPayload,
      traceId,
    });

    console.info('[viber-webhook] enqueued inbound message', {
      channelId,
      event,
      traceId,
    });
  } catch (err) {
    console.error('[viber-webhook] failed to enqueue inbound payload', { channelId, err, traceId });
  }
}
