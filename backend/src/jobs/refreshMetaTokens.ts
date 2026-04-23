import pool from '../db/pool';
import { updateChannel, type Channel } from '../db/models/channel';
import { createAIAlert } from '../db/models/aiAlert';
import { cryptoService } from '../services/cryptoService';
import { socketService } from '../services/socketService';
import { defaultQueue } from './queues';
import type { GenerateProductEmbeddingJobData } from './generateProductEmbedding';

/** BullMQ repeat pattern: every Monday 09:00 (server timezone). */
const META_TOKEN_REFRESH_CRON = '0 9 * * 1';

export type RefreshMetaTokensJobData = Record<string, never>;

async function listVerifiedMetaChannels(): Promise<Channel[]> {
  const { rows } = await pool.query<Channel>(
    `SELECT * FROM channels
     WHERE webhook_verified = true
       AND type IN ('facebook', 'instagram')
     ORDER BY tenant_id, created_at`,
  );
  return rows;
}

interface MetaDebugTokenResponse {
  data?: {
    expires_at?: number;
  };
  error?: { message?: string };
}

async function fetchMetaExpiresAt(
  userAccessToken: string,
  appId: string,
  appSecret: string,
): Promise<number | null> {
  const url = new URL('https://graph.facebook.com/debug_token');
  url.searchParams.set('input_token', userAccessToken);
  url.searchParams.set('access_token', `${appId}|${appSecret}`);
  const res = await fetch(url.toString());
  const json = (await res.json()) as MetaDebugTokenResponse;
  if (json.error || json.data == null) {
    console.error('[meta.token.refresh] debug_token error', { message: json.error?.message });
    return null;
  }
  const exp = json.data.expires_at;
  return typeof exp === 'number' ? exp : null;
}

function daysUntilExpiry(expiresAtUnixSec: number): number {
  const nowSec = Date.now() / 1000;
  return (expiresAtUnixSec - nowSec) / 86400;
}

interface MetaExchangeResponse {
  access_token?: string;
  error?: { message?: string };
}

async function exchangeMetaLongLivedToken(
  currentToken: string,
  appId: string,
  appSecret: string,
): Promise<string | null> {
  const url = new URL('https://graph.facebook.com/oauth/access_token');
  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('fb_exchange_token', currentToken);
  const res = await fetch(url.toString());
  const json = (await res.json()) as MetaExchangeResponse;
  if (json.error || !json.access_token) {
    console.error('[meta.token.refresh] oauth/access_token error', { message: json.error?.message });
    return null;
  }
  return json.access_token;
}

async function onRefreshFailure(tenantId: string, channel: Channel): Promise<void> {
  const alert = await createAIAlert({
    tenant_id: tenantId,
    conversation_id: null,
    message_id: null,
    reason: 'token_refresh_failed',
  });
  socketService.emitAIAlert(tenantId, {
    ...alert,
    message_content: null,
    contact_name: 'System',
    channel_type: channel.type,
    channel_name: channel.name,
  });
  console.error('[meta.token.refresh] Refresh failed', { tenantId, channelId: channel.id });
}

async function processMetaChannel(channel: Channel, appId: string, appSecret: string): Promise<void> {
  try {
    let accessToken: string;
    try {
      accessToken = cryptoService.decrypt(channel.access_token_encrypted);
    } catch (err) {
      console.error('[meta.token.refresh] decrypt failed', {
        tenantId: channel.tenant_id,
        channelId: channel.id,
        err,
      });
      return;
    }

    const expiresAt = await fetchMetaExpiresAt(accessToken, appId, appSecret);
    if (expiresAt === null) {
      console.warn('[meta.token.refresh] no expiry from debug_token, skipping', {
        tenantId: channel.tenant_id,
        channelId: channel.id,
      });
      return;
    }
    if (expiresAt === 0) {
      return;
    }

    if (daysUntilExpiry(expiresAt) > 10) {
      return;
    }

    try {
      const newToken = await exchangeMetaLongLivedToken(accessToken, appId, appSecret);
      if (!newToken) {
        await onRefreshFailure(channel.tenant_id, channel);
        return;
      }
      const encrypted = cryptoService.encrypt(newToken);
      const updated = await updateChannel(channel.id, channel.tenant_id, {
        access_token_encrypted: encrypted,
      });
      if (!updated) {
        await onRefreshFailure(channel.tenant_id, channel);
        return;
      }
      console.info('[meta.token.refresh] token updated', {
        tenantId: channel.tenant_id,
        channelId: channel.id,
      });
    } catch (err) {
      try {
        await onRefreshFailure(channel.tenant_id, channel);
      } catch (notifyErr) {
        console.error('[meta.token.refresh] alert after failure failed', {
          tenantId: channel.tenant_id,
          channelId: channel.id,
          notifyErr,
        });
      }
      console.error('[meta.token.refresh] refresh threw', {
        tenantId: channel.tenant_id,
        channelId: channel.id,
        err,
      });
    }
  } catch (err) {
    console.error('[meta.token.refresh] per-channel error', {
      tenantId: channel.tenant_id,
      channelId: channel.id,
      err,
    });
  }
}

export async function processRefreshMetaTokens(): Promise<void> {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    console.error('[meta.token.refresh] META_APP_ID / META_APP_SECRET not configured, aborting run');
    return;
  }

  const channels = await listVerifiedMetaChannels();
  console.info('[meta.token.refresh] scanning channels', { count: channels.length });

  for (const channel of channels) {
    await processMetaChannel(channel, appId, appSecret);
  }
}

export async function initRefreshMetaTokensScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    'meta-token-refresh-weekly',
    { pattern: META_TOKEN_REFRESH_CRON },
    {
      name: 'refreshMetaTokens',
      data: {} as GenerateProductEmbeddingJobData,
      opts: {
        attempts: 1,
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 25 },
      },
    },
  );
  console.info('[meta.token.refresh] Scheduler registered', { pattern: META_TOKEN_REFRESH_CRON });
}
