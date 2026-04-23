import axios from 'axios';
import type { Channel, ChannelType } from '../db/models/channel';
import { cryptoService } from './cryptoService';
import { acquireOutboundSendToken } from './outboundChannelRateLimiter';

/** Keep in sync with Meta OAuth / Graph usage elsewhere (e.g. metaOAuthController). */
const GRAPH_API_BASE = 'https://graph.facebook.com/v25.0';
const INSTAGRAM_GRAPH_API_BASE = 'https://graph.instagram.com/v25.0';

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
  const accessToken = decryptToken(channel);
  if (channel.connection_method === 'oauth_instagram') {
    /**
     * Instagram business login channels are stored with IG account id in `external_id`.
     * Sending is done against that IG id using the Instagram access token.
     */
    const resp = await axios.post(
      `${INSTAGRAM_GRAPH_API_BASE}/${channel.external_id}/messages`,
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

export type ChannelSendMessageResult = {
  success: boolean;
  error?: string;
  /** Meta message id when returned (Facebook / Instagram); often null for WhatsApp. */
  graphMessageId?: string | null;
};

function logChannelSendError(channelLabel: string, error: unknown): void {
  const errMsg = error instanceof Error ? error.message : String(error);
  const graphBody =
    axios.isAxiosError(error) && error.response?.data
      ? JSON.stringify(error.response.data)
      : '';
  console.error(
    `[channelSender] Failed to send ${channelLabel} message:`,
    errMsg,
    graphBody ? `Graph: ${graphBody}` : '',
  );
}

export async function sendViaFacebook(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<ChannelSendMessageResult> {
  try {
    const graphMessageId = await sendFacebookMessage(channel, recipientExternalId, messageText);
    return { success: true, graphMessageId: graphMessageId ?? null };
  } catch (error) {
    logChannelSendError('facebook', error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

export async function sendViaInstagram(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<ChannelSendMessageResult> {
  try {
    const graphMessageId = await sendInstagramMessage(channel, recipientExternalId, messageText);
    return { success: true, graphMessageId: graphMessageId ?? null };
  } catch (error) {
    logChannelSendError('instagram', error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

export async function sendViaWhatsApp(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<ChannelSendMessageResult> {
  try {
    const graphMessageId = await sendWhatsAppMessage(channel, recipientExternalId, messageText);
    return { success: true, graphMessageId: graphMessageId ?? null };
  } catch (error) {
    logChannelSendError('whatsapp', error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

const graphSenders: Record<
  ChannelType,
  (channel: Channel, recipientExternalId: string, messageText: string) => Promise<string | null>
> = {
  facebook: sendFacebookMessage,
  instagram: sendInstagramMessage,
  whatsapp: sendWhatsAppMessage,
};

const sendViaByType: Record<
  ChannelType,
  (
    channel: Channel,
    recipientExternalId: string,
    messageText: string,
  ) => Promise<ChannelSendMessageResult>
> = {
  facebook: sendViaFacebook,
  instagram: sendViaInstagram,
  whatsapp: sendViaWhatsApp,
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
): Promise<ChannelSendMessageResult> {
  const sendVia = sendViaByType[channel.type];
  if (!sendVia) {
    console.error(`[channelSender] Unsupported channel type: ${channel.type}`);
    return { success: false, error: `Unsupported channel type: ${channel.type}` };
  }

  try {
    await acquireOutboundSendToken(channel.id);
    assertSupportedConnectionMethod(channel);
    return await sendVia(channel, recipientExternalId, messageText);
  } catch (error) {
    logChannelSendError(channel.type, error);
    const errMsg = error instanceof Error ? error.message : String(error);
    return { success: false, error: errMsg };
  }
}

/** Same as sendMessage but propagates errors (for API handlers that need to report failure). */
export async function sendMessageStrict(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<void> {
  const sender = graphSenders[channel.type];
  if (!sender) {
    throw new Error(`Unsupported channel type: ${channel.type}`);
  }

  await acquireOutboundSendToken(channel.id);
  assertSupportedConnectionMethod(channel);
  await sender(channel, recipientExternalId, messageText);
}
