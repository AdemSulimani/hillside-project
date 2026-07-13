import axios from 'axios';
import type { Request, Response } from 'express';
import {
  createChannel,
  findChannelByExternalId,
  findConflictingChannelBinding,
  updateChannel,
} from '../db/models/channel';
import type { Channel } from '../db/models/channel';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { cryptoService } from '../services/cryptoService';
import { sendError, sendSuccess } from '../utils/response';

export const VIBER_API_BASE = 'https://chatapi.viber.com/pa';

function sanitizeChannel(channel: Channel): Omit<Channel, 'access_token_encrypted'> {
  const { access_token_encrypted: _token, ...rest } = channel;
  return rest;
}

function requireBackendUrl(): string {
  const url = process.env.BACKEND_URL?.trim().replace(/\/$/, '');
  if (!url) {
    throw new Error('BACKEND_URL environment variable must be set for Viber webhook registration');
  }
  return url;
}

interface ViberAccountInfo {
  status: number;
  status_message: string;
  id: string;
  name: string;
  uri: string;
  icon?: string;
}

/**
 * Validates the Viber auth token by calling `get_account_info`.
 * Returns the bot's account details (id, name, uri).
 */
async function fetchViberAccountInfo(authToken: string): Promise<ViberAccountInfo> {
  const { data } = await axios.post<ViberAccountInfo>(
    `${VIBER_API_BASE}/get_account_info`,
    {},
    {
      headers: {
        'X-Viber-Auth-Token': authToken,
        'Content-Type': 'application/json',
      },
    },
  );

  if (data.status !== 0) {
    throw new Error(
      `Viber API error: ${data.status_message ?? 'Unknown error'} (status ${data.status})`,
    );
  }

  return data;
}

/**
 * Registers the webhook URL for a Viber bot channel. Viber will immediately POST a
 * `{"event":"webhook",...}` callback to the URL to verify it is reachable.
 */
async function setViberWebhook(authToken: string, webhookUrl: string): Promise<void> {
  const { data } = await axios.post<{ status: number; status_message: string }>(
    `${VIBER_API_BASE}/set_webhook`,
    {
      url: webhookUrl,
      event_types: ['message', 'subscribed', 'unsubscribed', 'conversation_started'],
      send_name: true,
      send_photo: true,
    },
    {
      headers: {
        'X-Viber-Auth-Token': authToken,
        'Content-Type': 'application/json',
      },
    },
  );

  if (data.status !== 0) {
    throw new Error(
      `Viber set_webhook failed: ${data.status_message ?? 'Unknown error'} (status ${data.status})`,
    );
  }
}

/**
 * Removes the Viber webhook for a bot by setting an empty URL.
 * Called during channel deletion (best-effort; errors are logged but not propagated).
 */
export async function removeViberWebhook(authToken: string): Promise<void> {
  await axios.post(
    `${VIBER_API_BASE}/set_webhook`,
    { url: '' },
    {
      headers: {
        'X-Viber-Auth-Token': authToken,
        'Content-Type': 'application/json',
      },
    },
  );
}

/**
 * Connect a Viber bot channel.
 *
 * Flow:
 * 1. Validate auth token via `get_account_info` (also fetches bot id/name).
 * 2. Create or update the channel row in the DB.
 * 3. Call `set_webhook` with the channel-specific URL
 *    (`{BACKEND_URL}/api/webhooks/viber/{channelId}`).
 * 4. Viber sends a webhook verification callback which our handler responds to with 200
 *    and marks `webhook_verified = true`.
 *
 * Body: `{ auth_token: string }`
 */
export async function connectViber(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { auth_token } = req.body as { auth_token: string };

    // 1. Validate token and fetch bot metadata.
    const accountInfo = await fetchViberAccountInfo(auth_token);

    const botId = accountInfo.id;
    const botName = accountInfo.name?.trim() || `Viber Bot ${botId}`;
    const botUri = accountInfo.uri?.trim() || null;

    const encryptedToken = cryptoService.encrypt(auth_token);
    const metadata: Record<string, unknown> = { bot_uri: botUri, bot_id: botId };

    // P1-7 (RC-09 / SEC-2): refuse to connect a bot already bound to another business.
    // A same-tenant reconnect returns null and proceeds to the update branch below.
    const conflict = await findConflictingChannelBinding(tenantId, 'viber', botId);
    if (conflict) {
      sendError(res, 'This Viber bot is already connected to another business.', 409);
      return;
    }

    // 2. Create or update the channel.
    const existing = await findChannelByExternalId(tenantId, 'viber', botId);

    let channel: Channel;

    if (existing) {
      const updated = await updateChannel(existing.id, tenantId, {
        name: botName,
        access_token_encrypted: encryptedToken,
        connection_method: 'viber_bot',
        webhook_verified: false,
        metadata,
      });
      if (!updated) {
        sendError(res, 'Failed to update Viber channel', 500);
        return;
      }
      channel = updated;
    } else {
      channel = await createChannel({
        tenant_id: tenantId,
        type: 'viber',
        name: botName,
        external_id: botId,
        access_token_encrypted: encryptedToken,
        connection_method: 'viber_bot',
        webhook_verified: false,
        metadata,
      });
    }

    // 3. Register the webhook. The URL contains the channel UUID so each bot has its own
    //    endpoint, enabling per-channel token-based HMAC verification.
    const backendUrl = requireBackendUrl();
    const webhookUrl = `${backendUrl}/api/webhooks/viber/${channel.id}`;

    await setViberWebhook(auth_token, webhookUrl);

    sendSuccess(
      res,
      { channel: sanitizeChannel(channel) },
      'Viber channel connected successfully',
      existing ? 200 : 201,
    );
  } catch (err) {
    // P1-7: the DB global UNIQUE (migration 075) is the hard backstop if the pre-check races.
    if (isPgUniqueViolation(err)) {
      sendError(res, 'This Viber bot is already connected to another business.', 409);
      return;
    }
    if (axios.isAxiosError(err)) {
      const body = err.response?.data as { status_message?: string } | undefined;
      const msg = body?.status_message?.trim() || 'Viber API request failed';
      sendError(res, msg, 400, err.response?.data ?? err.message);
      return;
    }

    if (err instanceof Error) {
      sendError(res, err.message, 500);
      return;
    }

    sendError(res, 'Failed to connect Viber channel', 500, err);
  }
}
