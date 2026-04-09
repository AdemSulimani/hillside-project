import axios from 'axios';
import type { Channel, ChannelType } from '../db/models/channel';
import { cryptoService } from './cryptoService';

const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

function decryptToken(channel: Channel): string {
  return cryptoService.decrypt(channel.access_token_encrypted);
}

async function sendFacebookMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<void> {
  const accessToken = decryptToken(channel);

  await axios.post(
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
}

async function sendInstagramMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<void> {
  const accessToken = decryptToken(channel);
  const pageId = channel.external_id;

  await axios.post(
    `${GRAPH_API_BASE}/${pageId}/messages`,
    {
      recipient: { id: recipientExternalId },
      message: { text: messageText },
    },
    {
      params: { access_token: accessToken },
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

async function sendWhatsAppMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<void> {
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
}

const senders: Record<
  ChannelType,
  (channel: Channel, recipientExternalId: string, messageText: string) => Promise<void>
> = {
  facebook: sendFacebookMessage,
  instagram: sendInstagramMessage,
  whatsapp: sendWhatsAppMessage,
};

export async function sendMessage(
  channel: Channel,
  recipientExternalId: string,
  messageText: string,
): Promise<void> {
  const sender = senders[channel.type];
  if (!sender) {
    console.error(`[channelSender] Unsupported channel type: ${channel.type}`);
    return;
  }

  try {
    await sender(channel, recipientExternalId, messageText);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[channelSender] Failed to send ${channel.type} message:`, errMsg);
  }
}
