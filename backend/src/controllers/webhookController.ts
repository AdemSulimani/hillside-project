import crypto from 'crypto';
import type { Request, Response } from 'express';
import { sendError } from '../utils/response';
import { webhookQueue } from '../jobs/queues';
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
