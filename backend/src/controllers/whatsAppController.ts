import type { Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createChannel, findChannelByExternalId, updateChannel } from '../db/models/channel';
import type { Channel } from '../db/models/channel';
import { redisConnection } from '../jobs/redisConnection';
import { cryptoService } from '../services/cryptoService';
import { sendError, sendSuccess } from '../utils/response';

const GRAPH_OAUTH_VERSION = 'v25.0';
const OAUTH_ACCESS_TOKEN_URL = `https://graph.facebook.com/${GRAPH_OAUTH_VERSION}/oauth/access_token`;

function signupStateKey(tenantId: string): string {
  return `whatsapp_signup_state:${tenantId}`;
}

function sanitizeChannel(channel: Channel): Omit<Channel, 'access_token_encrypted'> {
  const { access_token_encrypted: _token, ...rest } = channel;
  return rest;
}

function requireMetaApp(): { appId: string; appSecret: string } {
  const appId = process.env.META_APP_ID?.trim();
  const appSecret = process.env.META_APP_SECRET?.trim();
  if (!appId || !appSecret) {
    throw new Error('META_APP_ID and META_APP_SECRET must be configured');
  }
  return { appId, appSecret };
}

/** Comma-separated in WHATSAPP_EMBEDDED_SIGNUP_REDIRECT_URI; each entry must match Meta Valid OAuth Redirect URIs exactly. */
function getAllowedEmbeddedSignupRedirectUris(): string[] {
  const raw = process.env.WHATSAPP_EMBEDDED_SIGNUP_REDIRECT_URI?.trim();
  if (!raw) {
    throw new Error('WHATSAPP_EMBEDDED_SIGNUP_REDIRECT_URI is not configured');
  }
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Prefer the redirect_uri observed in the browser so the token exchange matches Meta's OAuth dialog.
 * When omitted, only allowed if the env lists a single redirect URI (backward compatible).
 */
function resolveRedirectUriForTokenExchange(clientRedirectUri: string | undefined): string {
  const allowed = getAllowedEmbeddedSignupRedirectUris();
  const client = clientRedirectUri?.trim();
  if (client) {
    if (!allowed.includes(client)) {
      throw new Error(
        'redirect_uri is not allowed. Add this exact URL to WHATSAPP_EMBEDDED_SIGNUP_REDIRECT_URI on the server (comma-separated for multiple), and to Meta Facebook Login for Business → Valid OAuth redirect URIs.',
      );
    }
    return client;
  }
  if (allowed.length === 1) {
    return allowed[0]!;
  }
  throw new Error(
    'redirect_uri is required in the request when WHATSAPP_EMBEDDED_SIGNUP_REDIRECT_URI lists more than one URL.',
  );
}

function graphManagementBase(): string {
  const fromEnv = process.env.WHATSAPP_BUSINESS_MANAGEMENT_API?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, '');
  }
  return `https://graph.facebook.com/${GRAPH_OAUTH_VERSION}`;
}

function appSecretProof(appSecret: string, accessToken: string): string {
  return crypto.createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

export async function generateSignupState(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const state = crypto.randomUUID();
    await redisConnection.setex(signupStateKey(tenantId), 600, state);
    sendSuccess(res, { state }, 'WhatsApp signup state issued');
  } catch (err) {
    sendError(res, 'Failed to generate signup state', 500, err);
  }
}

async function exchangeCodeForUserAccessToken(code: string, redirectUri: string): Promise<string> {
  const { appId, appSecret } = requireMetaApp();

  const { data } = await axios.post<{ access_token?: string }>(
    OAUTH_ACCESS_TOKEN_URL,
    null,
    {
      params: {
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: redirectUri,
      },
    },
  );

  if (!data.access_token) {
    throw new Error('OAuth token exchange did not return access_token');
  }
  return data.access_token;
}

async function exchangeUserForSystemUserToken(userAccessToken: string): Promise<string> {
  const { appSecret } = requireMetaApp();
  const businessId = process.env.WHATSAPP_BUSINESS_ID?.trim();
  const systemUserId = process.env.WHATSAPP_SYSTEM_USER_ID?.trim();
  if (!businessId) {
    throw new Error('WHATSAPP_BUSINESS_ID is not configured');
  }
  if (!systemUserId) {
    throw new Error('WHATSAPP_SYSTEM_USER_ID is not configured');
  }

  const url = `${graphManagementBase()}/${businessId}/system_user_access_tokens`;
  const proof = appSecretProof(appSecret, userAccessToken);

  const { data } = await axios.post<{ access_token?: string }>(url, null, {
    params: {
      appsecret_proof: proof,
      access_token: userAccessToken,
      system_user_id: systemUserId,
    },
  });

  if (!data.access_token) {
    throw new Error('system_user_access_tokens did not return access_token');
  }
  return data.access_token;
}

async function resolveWabaId(userAccessToken: string): Promise<string> {
  const { appId, appSecret } = requireMetaApp();
  const debugUrl = `${graphManagementBase()}/debug_token`;
  const { data } = await axios.get<{
    data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> };
  }>(debugUrl, {
    params: {
      input_token: userAccessToken,
      access_token: `${appId}|${appSecret}`,
    },
  });

  const granular = data.data?.granular_scopes ?? [];
  for (const g of granular) {
    if (g.scope === 'whatsapp_business_management' && g.target_ids?.length) {
      return g.target_ids[0]!;
    }
  }
  for (const g of granular) {
    if (g.target_ids?.length) {
      return g.target_ids[0]!;
    }
  }

  const businessId = process.env.WHATSAPP_BUSINESS_ID?.trim();
  if (!businessId) {
    throw new Error('Could not resolve WhatsApp Business Account ID from token');
  }

  const listUrl = `${graphManagementBase()}/${businessId}/client_whatsapp_business_accounts`;
  const list = await axios.get<{ data?: Array<{ id?: string }> }>(listUrl, {
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  const firstId = list.data.data?.[0]?.id;
  if (!firstId) {
    throw new Error('Could not resolve WhatsApp Business Account ID');
  }
  return firstId;
}

async function fetchPrimaryPhoneNumber(
  wabaId: string,
  systemUserToken: string,
): Promise<{ phoneNumberId: string; displayPhoneNumber: string }> {
  const url = `${graphManagementBase()}/${wabaId}/phone_numbers`;
  const { data } = await axios.get<{
    data?: Array<{ id?: string; display_phone_number?: string }>;
  }>(url, {
    params: { fields: 'id,display_phone_number' },
    headers: { Authorization: `Bearer ${systemUserToken}` },
  });

  const row = data.data?.[0];
  if (!row?.id) {
    throw new Error('No phone numbers found for WhatsApp Business Account');
  }

  const display = row.display_phone_number?.trim() || `WhatsApp ${row.id}`;
  return { phoneNumberId: row.id, displayPhoneNumber: display };
}

export async function handleEmbeddedSignup(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const input = req.body as { code: string; state: string; redirect_uri?: string };

    const storedState = await redisConnection.get(signupStateKey(tenantId));
    if (!storedState || storedState !== input.state) {
      sendError(res, 'Invalid or expired signup state', 403);
      return;
    }
    await redisConnection.del(signupStateKey(tenantId));

    let redirectUriForExchange: string;
    try {
      redirectUriForExchange = resolveRedirectUriForTokenExchange(input.redirect_uri);
    } catch (resolveErr) {
      if (resolveErr instanceof Error && resolveErr.message.startsWith('redirect_uri')) {
        sendError(res, resolveErr.message, 400);
        return;
      }
      throw resolveErr;
    }

    const userAccessToken = await exchangeCodeForUserAccessToken(input.code, redirectUriForExchange);
    const systemUserToken = await exchangeUserForSystemUserToken(userAccessToken);
    const wabaId = await resolveWabaId(userAccessToken);
    const { phoneNumberId, displayPhoneNumber } = await fetchPrimaryPhoneNumber(
      wabaId,
      systemUserToken,
    );

    const encryptedToken = cryptoService.encrypt(systemUserToken);
    const metadata = {
      waba_id: wabaId,
      phone_number_id: phoneNumberId,
      display_phone_number: displayPhoneNumber,
      source: 'whatsapp_embedded_signup',
    };

    const existing = await findChannelByExternalId(tenantId, 'whatsapp', phoneNumberId);
    if (existing) {
      const updated = await updateChannel(existing.id, tenantId, {
        name: displayPhoneNumber,
        access_token_encrypted: encryptedToken,
        connection_method: 'embedded_signup',
        webhook_verified: true,
        metadata,
      });
      if (!updated) {
        sendError(res, 'Failed to update WhatsApp channel', 500);
        return;
      }

      sendSuccess(res, { channel: sanitizeChannel(updated) }, 'WhatsApp channel updated successfully');
      return;
    }

    const created = await createChannel({
      tenant_id: tenantId,
      type: 'whatsapp',
      name: displayPhoneNumber,
      external_id: phoneNumberId,
      access_token_encrypted: encryptedToken,
      connection_method: 'embedded_signup',
      webhook_verified: true,
      metadata,
    });

    sendSuccess(
      res,
      { channel: sanitizeChannel(created) },
      'WhatsApp channel connected successfully',
      201,
    );
  } catch (err) {
    if (axios.isAxiosError(err)) {
      sendError(
        res,
        'WhatsApp Embedded Signup failed',
        400,
        err.response?.data ?? err.message,
      );
      return;
    }

    if (err instanceof Error) {
      sendError(res, err.message, 500);
      return;
    }

    sendError(res, 'WhatsApp Embedded Signup failed', 500, err);
  }
}
