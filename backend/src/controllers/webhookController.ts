import crypto from 'crypto';
import type { Request, Response } from 'express';
import { sendError } from '../utils/response';
import { inboundMessageQueue } from '../jobs/queues';
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
      await inboundMessageQueue.add('message.inbound', {
        channelType: channelTypeParam,
        payload: parsedPayload,
      });
    } catch (err) {
      console.error('[webhook] failed to enqueue inbound payload', err);
    }
  };

  // TEMPORARY - skip signature check in development.
  if (process.env.NODE_ENV === 'development') {
    res.sendStatus(200);
    console.log('=== RAW PAYLOAD ===', JSON.stringify(req.body, null, 2));
    // still enqueue...
    void enqueueInboundPayload();
    return;
  }

  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) {
    sendError(res, 'META_APP_SECRET is not configured', 500);
    return;
  }

  const signatureHeader = req.header('X-Hub-Signature-256');
  if (!signatureHeader) {
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
    res.sendStatus(403);
    return;
  }

  res.sendStatus(200);
  console.log('=== RAW PAYLOAD ===', JSON.stringify(req.body, null, 2));
  void enqueueInboundPayload();
}
