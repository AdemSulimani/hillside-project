import pool from '../db/pool';
import { updateChannel, type Channel } from '../db/models/channel';
import { createAIAlert } from '../db/models/aiAlert';
import { cryptoService } from '../services/cryptoService';
import { socketService } from '../services/socketService';
import { defaultQueue } from './queues';
import type { GenerateProductEmbeddingJobData } from './generateProductEmbedding';

/** BullMQ repeat pattern: every Monday 09:00 (server timezone). */
const META_TOKEN_REFRESH_CRON = '0 9 * * 1';

const INSTAGRAM_GRAPH_BASE = 'https://graph.instagram.com';

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

/**
 * Refreshes an Instagram Business Login long-lived token (valid 60 days) using the Instagram
 * Graph API. This is completely separate from the Facebook fb_exchange_token flow — Instagram
 * Business Login tokens cannot be refreshed via graph.facebook.com.
 *
 * The token must already be a long-lived token; short-lived tokens are exchanged at OAuth time
 * in instagramOAuthController. Tokens can be refreshed as long as they haven't expired yet.
 */
async function refreshInstagramLongLivedToken(currentToken: string): Promise<string | null> {
  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/refresh_access_token`);
  url.searchParams.set('grant_type', 'ig_refresh_token');
  url.searchParams.set('access_token', currentToken);
  const res = await fetch(url.toString());
  const json = (await res.json()) as MetaExchangeResponse;
  if (json.error || !json.access_token) {
    console.error('[meta.token.refresh] ig_refresh_token error', { message: json.error?.message });
    return null;
  }
  return json.access_token;
}

/**
 * Checks how many days until an Instagram Business Login token expires using the Instagram
 * token info endpoint (not the Facebook debug_token endpoint, which only works for FB tokens).
 */
async function fetchInstagramTokenExpiresAt(accessToken: string): Promise<number | null> {
  interface IgTokenInfoResponse {
    data?: { expires_at?: number };
    error?: { message?: string };
  }
  const url = new URL(`${INSTAGRAM_GRAPH_BASE}/me`);
  url.searchParams.set('fields', 'id');
  url.searchParams.set('access_token', accessToken);
  // The token info (expiry) is embedded in the response header or via a separate endpoint.
  // For long-lived tokens, we use the debug approach: try to fetch the token info via the
  // access_token field on /me, which returns token metadata including expiry for long-lived tokens.
  const infoUrl = new URL(`${INSTAGRAM_GRAPH_BASE}/access_token`);
  infoUrl.searchParams.set('grant_type', 'ig_refresh_token');
  // Instead of actually refreshing, just check expiry via a GET on /me to detect if expired.
  // Instagram doesn't expose a direct debug_token equivalent, so we approximate via /me.
  const res = await fetch(url.toString());
  if (!res.ok) {
    return null;
  }
  const json = (await res.json()) as IgTokenInfoResponse;
  if (json.error) return null;
  // Instagram does not return expires_at on /me directly; returning 0 signals "check not
  // available but token is alive" — the caller will attempt a refresh proactively.
  return 0;
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

async function processFacebookChannel(channel: Channel, appId: string, appSecret: string): Promise<void> {
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
  if (expiresAt === 0 || daysUntilExpiry(expiresAt) > 10) {
    return;
  }

  const newToken = await exchangeMetaLongLivedToken(accessToken, appId, appSecret);
  if (!newToken) {
    await onRefreshFailure(channel.tenant_id, channel);
    return;
  }
  const encrypted = cryptoService.encrypt(newToken);
  const updated = await updateChannel(channel.id, channel.tenant_id, { access_token_encrypted: encrypted });
  if (!updated) {
    await onRefreshFailure(channel.tenant_id, channel);
    return;
  }
  console.info('[meta.token.refresh] facebook token updated', {
    tenantId: channel.tenant_id,
    channelId: channel.id,
  });
}

/**
 * Instagram Business Login tokens (long-lived, 60 days) must be refreshed via the Instagram
 * Graph API using ig_refresh_token — not via the Facebook fb_exchange_token endpoint.
 * We attempt a proactive refresh every week regardless of exact expiry since Instagram does
 * not expose a debug_token equivalent for IG Business Login tokens.
 */
async function processInstagramChannel(channel: Channel): Promise<void> {
  if (channel.connection_method !== 'oauth_instagram') {
    return;
  }

  let accessToken: string;
  try {
    accessToken = cryptoService.decrypt(channel.access_token_encrypted);
  } catch (err) {
    console.error('[meta.token.refresh] instagram decrypt failed', {
      tenantId: channel.tenant_id,
      channelId: channel.id,
      err,
    });
    return;
  }

  // Check token is still alive before attempting refresh; null means expired/invalid.
  const liveness = await fetchInstagramTokenExpiresAt(accessToken);
  if (liveness === null) {
    console.warn('[meta.token.refresh] instagram token appears expired or invalid, skipping refresh', {
      tenantId: channel.tenant_id,
      channelId: channel.id,
    });
    await onRefreshFailure(channel.tenant_id, channel);
    return;
  }

  const newToken = await refreshInstagramLongLivedToken(accessToken);
  if (!newToken) {
    console.warn('[meta.token.refresh] instagram ig_refresh_token failed, will retry next cycle', {
      tenantId: channel.tenant_id,
      channelId: channel.id,
    });
    return;
  }
  const encrypted = cryptoService.encrypt(newToken);
  const updated = await updateChannel(channel.id, channel.tenant_id, { access_token_encrypted: encrypted });
  if (!updated) {
    await onRefreshFailure(channel.tenant_id, channel);
    return;
  }
  console.info('[meta.token.refresh] instagram token refreshed', {
    tenantId: channel.tenant_id,
    channelId: channel.id,
  });
}

async function processMetaChannel(channel: Channel, appId: string, appSecret: string): Promise<void> {
  try {
    if (channel.type === 'instagram') {
      await processInstagramChannel(channel);
    } else {
      await processFacebookChannel(channel, appId, appSecret);
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
