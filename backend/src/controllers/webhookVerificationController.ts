import crypto from 'crypto';
import type { Request, Response } from 'express';
import { sendError } from '../utils/response';

/** Constant-time string comparison to avoid leaking the verify token via timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function verifyMetaWebhook(req: Request, res: Response): void {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const expectedToken = process.env.WEBHOOK_VERIFY_TOKEN;

  if (!expectedToken) {
    sendError(res, 'WEBHOOK_VERIFY_TOKEN is not configured', 500);
    return;
  }

  if (
    mode === 'subscribe' &&
    typeof token === 'string' &&
    timingSafeEqualStr(token, expectedToken) &&
    typeof challenge === 'string'
  ) {
    res.status(200).send(challenge);
    return;
  }

  sendError(res, 'Webhook verification failed', 403);
}
