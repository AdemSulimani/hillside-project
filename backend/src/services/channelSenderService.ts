import axios from 'axios';
import type { Channel, ChannelType } from '../db/models/channel';
import { cryptoService } from './cryptoService';
import { acquireOutboundSendToken } from './outboundChannelRateLimiter';

/** Keep in sync with Meta OAuth / Graph usage elsewhere (e.g. metaOAuthController). */
const GRAPH_API_BASE = 'https://graph.facebook.com/v25.0';

function decryptToken(channel: Channel): string {
  return cryptoService.decrypt(channel.access_token_encrypted);
}

function readGraphSendMessageId(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const mid = (data as { message_id?: unknown }).message_id;
  if (typeof mid === 'string' && mid.trim()) return mid.trim();
  return null;
}

async function sendFacebookMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<string | null> {
  const accessToken = decryptToken(channel);

  const resp = await axios.post(
    `${GRAPH_API_BASE}/me/messages`,
    {
      recipient: { id: recipientExternalId },
      message: { text: messageText },
      messaging_type: 'RESPONSE',
    },
    {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
    },
  );

  return readGraphSendMessageId(resp.data);
}

/**
 * Instagram Messaging uses the Messenger send API with a **Page** access token.
 * `POST /me/messages` — `me` is the Page linked to the IG professional account.
 * Do NOT use the Instagram Business Account id in the path (that causes 400).
 * @see https://developers.facebook.com/docs/messenger-platform/instagram/features/send-message
 */
async function sendInstagramMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<string | null> {
  if (channel.connection_method === 'oauth_instagram') {
    throw new Error(
      'Instagram Login send path is not enabled yet; verify endpoint/payload for this product first',
    );
  }

  const accessToken = decryptToken(channel);

  const resp = await axios.post(
    `${GRAPH_API_BASE}/me/messages`,
    {
      recipient: { id: recipientExternalId },
      message: { text: messageText },
    },
    {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
    },
  );

  return readGraphSendMessageId(resp.data);
}

async function sendWhatsAppMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<string | null> {
  const accessToken = decryptToken(channel);
  const phoneNumberId = channel.external_id;

  await axios.post(
    `${GRAPH_API_BASE}/${phoneNumberId}/messages`,
    {
      messaging_product: 'whatsapp',
      to: recipientExternalId,
      type: 'text',
      text: { body: messageText },
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    },
  );
  return null;
}

export type SendMessageResult = { ok: boolean; graphMessageId: string | null };

const senders: Record<
  ChannelType,
  (channel: Channel, recipientExternalId: string, messageText: string) => Promise<string | null>
> = {
  facebook: sendFacebookMessage,
  instagram: sendInstagramMessage,
  whatsapp: sendWhatsAppMessage,
};

function assertSupportedConnectionMethod(channel: Channel): void {
  if (channel.type === 'facebook' && channel.connection_method !== 'oauth_meta') {
    throw new Error(
      `Unsupported connection method for facebook channel: ${channel.connection_method}`,
    );
  }

  if (channel.type === 'instagram' && channel.connection_method === 'manual') {
    throw new Error('Unsupported connection method for instagram channel: manual');
  }
}

export async function sendMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<SendMessageResult> {
  const sender = senders[channel.type];
  if (!sender) {
    console.error(`[channelSender] Unsupported channel type: ${channel.type}`);
    return { ok: false, graphMessageId: null };
  }

  try {
    await acquireOutboundSendToken(channel.id);
    assertSupportedConnectionMethod(channel);
    const graphMessageId = await sender(channel, recipientExternalId, messageText);
    return { ok: true, graphMessageId: graphMessageId ?? null };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const graphBody =
      axios.isAxiosError(error) && error.response?.data
        ? JSON.stringify(error.response.data)
        : '';
    console.error(
      `[channelSender] Failed to send ${channel.type} message:`,
      errMsg,
      graphBody ? `Graph: ${graphBody}` : '',
    );
    return { ok: false, graphMessageId: null };
  }
}

/** Same as sendMessage but propagates errors (for API handlers that need to report failure). */
export async function sendMessageStrict(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<void> {
  const sender = senders[channel.type];
  if (!sender) {
    throw new Error(`Unsupported channel type: ${channel.type}`);
  }

  await acquireOutboundSendToken(channel.id);
  assertSupportedConnectionMethod(channel);
  await sender(channel, recipientExternalId, messageText);
}
