import type { Request, Response } from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import {
  createChannel,
  findChannelByExternalId,
  findConflictingChannelBinding,
  updateChannel,
} from '../db/models/channel';
import { isPgUniqueViolation } from '../utils/pgErrors';
import { cryptoService } from '../services/cryptoService';
import { sendError, sendSuccess } from '../utils/response';

const INSTAGRAM_OAUTH_BASE = 'https://api.instagram.com/oauth';
const INSTAGRAM_GRAPH_BASE = 'https://graph.instagram.com/v25.0';
const INSTAGRAM_GRAPH_TOKEN_BASE = 'https://graph.instagram.com';
const META_GRAPH_BASE = 'https://graph.facebook.com/v25.0';

interface OAuthStatePayload {
  tenantId: string;
}

interface InstagramTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface InstagramLongLivedTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface InstagramIdentityResponse {
  user_id: string;
  username?: string;
  name?: string;
  account_type?: string;
  profile_picture_url?: string;
}

type SubscriptionAttemptResult = {
  endpoint: string;
  ok: boolean;
  data?: unknown;
  error?: unknown;
};

async function attemptSubscribeOnBase(
  baseUrl: string,
  igUserId: string,
  accessToken: string,
  subscribedFields: string,
): Promise<SubscriptionAttemptResult> {
  try {
    await axios.post(`${baseUrl}/${igUserId}/subscribed_apps`, null, {
      params: {
        access_token: accessToken,
        subscribed_fields: subscribedFields,
      },
    });

    const verifyResp = await axios.get(`${baseUrl}/${igUserId}/subscribed_apps`, {
      params: { access_token: accessToken },
    });

    return {
      endpoint: baseUrl,
      ok: true,
      data: verifyResp.data,
    };
  } catch (err) {
    return {
      endpoint: baseUrl,
      ok: false,
      error: axios.isAxiosError(err) ? err.response?.data ?? err.message : err,
    };
  }
}

/**
 * Exchanges a short-lived Instagram Business Login token (valid ~1 hour) for a long-lived token
 * (valid 60 days). Uses the Instagram Graph API — this is NOT the same as the Facebook
 * fb_exchange_token flow used for Page tokens.
 */
async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string,
): Promise<{ accessToken: string; expiresIn: number } | null> {
  try {
    const resp = await axios.get<InstagramLongLivedTokenResponse>(
      `${INSTAGRAM_GRAPH_TOKEN_BASE}/access_token`,
      {
        params: {
          grant_type: 'ig_exchange_token',
          client_id: appId,
          client_secret: appSecret,
          access_token: shortLivedToken,
        },
      },
    );
    if (!resp.data.access_token) return null;
    return { accessToken: resp.data.access_token, expiresIn: resp.data.expires_in };
  } catch (err) {
    console.warn('[instagram] Failed to exchange short-lived token for long-lived token', {
      error: axios.isAxiosError(err) ? err.response?.data ?? err.message : err,
    });
    return null;
  }
}

function getOAuthConfig() {
  const appId = process.env.INSTAGRAM_APP_ID;
  const appSecret = process.env.INSTAGRAM_APP_SECRET;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const jwtSecret = process.env.JWT_SECRET;
  const callbackUrl =
    process.env.INSTAGRAM_REDIRECT_URI || `${frontendUrl}/api/oauth/instagram/callback`;

  if (!appId || !appSecret || !jwtSecret) {
    throw new Error('INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET, and JWT_SECRET are required');
  }

  return { appId, appSecret, callbackUrl, jwtSecret };
}

function buildStateToken(tenantId: string, jwtSecret: string): string {
  return jwt.sign({ tenantId } satisfies OAuthStatePayload, jwtSecret, { expiresIn: '15m' });
}

function verifyStateToken(state: string, jwtSecret: string): OAuthStatePayload {
  return jwt.verify(state, jwtSecret) as OAuthStatePayload;
}

function getInstagramScopes(): string {
  return ['instagram_business_basic', 'instagram_business_manage_messages'].join(',');
}

export async function redirect(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { appId, callbackUrl, jwtSecret } = getOAuthConfig();
    const state = buildStateToken(tenantId, jwtSecret);
    const scopes = getInstagramScopes();

    const url = new URL(`${INSTAGRAM_OAUTH_BASE}/authorize`);
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    sendSuccess(res, { url: url.toString() }, 'Instagram OAuth URL generated successfully');
  } catch (err) {
    sendError(res, 'Failed to generate Instagram OAuth URL', 500, err);
  }
}

export async function callback(req: Request, res: Response): Promise<void> {
  try {
    const code = req.query.code as string | undefined;
    const state = req.query.state as string | undefined;

    if (!code || !state) {
      sendError(res, 'Missing code or state query parameters', 400);
      return;
    }

    const { appId, appSecret, callbackUrl, jwtSecret } = getOAuthConfig();
    const parsedState = verifyStateToken(state, jwtSecret);
    if (!parsedState.tenantId) {
      sendError(res, 'Invalid OAuth state payload', 400);
      return;
    }

    const tokenResp = await axios.post<InstagramTokenResponse>(
      `${INSTAGRAM_OAUTH_BASE}/access_token`,
      new URLSearchParams({
        client_id: appId,
        client_secret: appSecret,
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl,
        code,
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      },
    );

    const shortLivedToken = tokenResp.data.access_token;

    // Exchange the short-lived token (~1 hour) for a long-lived token (60 days) immediately.
    // Instagram Business Login uses a different exchange endpoint than Facebook Page tokens.
    const longLivedResult = await exchangeForLongLivedToken(shortLivedToken, appId, appSecret);
    const accessToken = longLivedResult?.accessToken ?? shortLivedToken;
    const resolvedExpiresIn = longLivedResult?.expiresIn ?? tokenResp.data.expires_in ?? null;

    if (longLivedResult) {
      console.info('[instagram] exchanged short-lived token for long-lived token', {
        expiresInDays: Math.round((longLivedResult.expiresIn ?? 0) / 86400),
      });
    } else {
      console.warn('[instagram] could not exchange for long-lived token; storing short-lived token');
    }

    const identityResp = await axios.get<InstagramIdentityResponse>(`${INSTAGRAM_GRAPH_BASE}/me`, {
      params: {
        fields: 'user_id,username,name,account_type,profile_picture_url',
        access_token: accessToken,
      },
    });

    const identity = identityResp.data;
    const externalId = identity.user_id;
    if (!externalId) {
      sendError(res, 'Instagram profile lookup did not return user_id', 400);
      return;
    }

    // graph.instagram.com does not have a `message_echoes` field — it's a Messenger/Facebook
    // concept. Passing it causes the entire subscription request to be rejected by Meta.
    // For Instagram Business Login, `messages` is the only field needed for inbound DMs.
    const subscriptionAttempts = await Promise.all([
      attemptSubscribeOnBase(INSTAGRAM_GRAPH_BASE, externalId, accessToken, 'messages'),
      attemptSubscribeOnBase(META_GRAPH_BASE, externalId, accessToken, 'messages,message_echoes'),
    ]);
    const successfulAttempt = subscriptionAttempts.find((attempt) => attempt.ok);
    if (successfulAttempt) {
      console.info('[instagram] subscribed_apps configured', {
        igUserId: externalId,
        endpoint: successfulAttempt.endpoint,
        subscribedApps: successfulAttempt.data,
      });
    } else {
      console.warn('[instagram] could not configure subscribed_apps during OAuth callback', {
        igUserId: externalId,
        attempts: subscriptionAttempts,
      });
    }

    const encrypted = cryptoService.encrypt(accessToken);
    const channelName = identity.username || identity.name || `Instagram ${externalId}`;
    const metadata = {
      source: 'instagram_oauth',
      username: identity.username ?? null,
      name: identity.name ?? null,
      account_type: identity.account_type ?? null,
      profile_picture_url: identity.profile_picture_url ?? null,
      token_type: tokenResp.data.token_type ?? null,
      expires_in: resolvedExpiresIn,
      long_lived_token: Boolean(longLivedResult),
      subscribed_apps_configured: Boolean(successfulAttempt),
      subscribed_apps_endpoint: successfulAttempt?.endpoint ?? null,
    };

    // P1-7 (RC-09 / SEC-2): refuse to connect an IG account already bound to another business
    // (a same-tenant reconnect returns null and proceeds to the update branch).
    const instagramConflict = await findConflictingChannelBinding(parsedState.tenantId, 'instagram', externalId);
    if (instagramConflict) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const redirectUrl = new URL('/channels', frontendUrl);
      redirectUrl.searchParams.set('status', 'error');
      redirectUrl.searchParams.set('type', 'instagram');
      redirectUrl.searchParams.set('reason', 'already_connected');
      res.redirect(302, redirectUrl.toString());
      return;
    }

    const existing = await findChannelByExternalId(parsedState.tenantId, 'instagram', externalId);
    if (existing) {
      await updateChannel(existing.id, parsedState.tenantId, {
        name: channelName,
        access_token_encrypted: encrypted,
        connection_method: 'oauth_instagram',
        webhook_verified: Boolean(successfulAttempt),
        metadata,
      });
    } else {
      await createChannel({
        tenant_id: parsedState.tenantId,
        type: 'instagram',
        name: channelName,
        external_id: externalId,
        access_token_encrypted: encrypted,
        connection_method: 'oauth_instagram',
        webhook_verified: Boolean(successfulAttempt),
        metadata,
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const redirectUrl = new URL('/channels', frontendUrl);
    redirectUrl.searchParams.set('status', 'connected');
    redirectUrl.searchParams.set('type', 'instagram');
    res.redirect(302, redirectUrl.toString());
  } catch (err) {
    // P1-7: the DB global UNIQUE (migration 075) is the hard backstop if the pre-check races.
    if (isPgUniqueViolation(err)) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const redirectUrl = new URL('/channels', frontendUrl);
      redirectUrl.searchParams.set('status', 'error');
      redirectUrl.searchParams.set('type', 'instagram');
      redirectUrl.searchParams.set('reason', 'already_connected');
      res.redirect(302, redirectUrl.toString());
      return;
    }
    if (axios.isAxiosError(err)) {
      sendError(
        res,
        'Instagram OAuth callback failed',
        400,
        err.response?.data ?? err.message,
      );
      return;
    }
    sendError(res, 'Instagram OAuth callback failed', 500, err);
  }
}
