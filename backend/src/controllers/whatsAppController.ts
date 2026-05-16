import type { Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import { createChannel, findChannelByExternalId, updateChannel } from '../db/models/channel';
import type { Channel } from '../db/models/channel';
import { redisConnection } from '../jobs/redisConnection';
import { cryptoService } from '../services/cryptoService';
import {
  buildWhatsAppChannelMetadata,
  ensureCloudApiRegistration,
} from '../services/whatsAppRegistrationService';
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

function graphManagementBase(): string {
  const fromEnv = process.env.WHATSAPP_BUSINESS_MANAGEMENT_API?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, '');
  }
  return `https://graph.facebook.com/${GRAPH_OAUTH_VERSION}`;
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

/**
 * Embedded Signup (Tech Provider): exchange the short-lived code for the customer's
 * [business integration / system user access token](https://developers.facebook.com/docs/whatsapp/access-tokens#business-integration-system-user-access-tokens)
 * via GET/POST `oauth/access_token` — only `client_id`, `client_secret`, and `code` (no `redirect_uri`).
 * Do not call `/{business-id}/system_user_access_tokens` with this token; that edge is a different flow and returns #33 / unknown errors for Embedded Signup.
 */
async function exchangeEmbeddedSignupCodeForBusinessToken(code: string): Promise<string> {
  const { appId, appSecret } = requireMetaApp();

  const { data } = await axios.post<{ access_token?: string }>(
    OAUTH_ACCESS_TOKEN_URL,
    null,
    {
      params: {
        client_id: appId,
        client_secret: appSecret,
        code,
      },
    },
  );

  if (!data.access_token) {
    throw new Error('OAuth token exchange did not return access_token');
  }
  return data.access_token;
}

async function resolveWabaId(businessToken: string): Promise<string> {
  const { appId, appSecret } = requireMetaApp();
  const debugUrl = `${graphManagementBase()}/debug_token`;
  const { data } = await axios.get<{
    data?: { granular_scopes?: Array<{ scope?: string; target_ids?: string[] }> };
  }>(debugUrl, {
    params: {
      input_token: businessToken,
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
    headers: { Authorization: `Bearer ${businessToken}` },
  });
  const firstId = list.data.data?.[0]?.id;
  if (!firstId) {
    throw new Error('Could not resolve WhatsApp Business Account ID');
  }
  return firstId;
}

async function fetchPrimaryPhoneNumber(
  wabaId: string,
  businessToken: string,
): Promise<{ phoneNumberId: string; displayPhoneNumber: string }> {
  const url = `${graphManagementBase()}/${wabaId}/phone_numbers`;
  const { data } = await axios.get<{
    data?: Array<{ id?: string; display_phone_number?: string }>;
  }>(url, {
    params: { fields: 'id,display_phone_number' },
    headers: { Authorization: `Bearer ${businessToken}` },
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
    const input = req.body as { code: string; state: string };

    const storedState = await redisConnection.get(signupStateKey(tenantId));
    if (!storedState || storedState !== input.state) {
      sendError(res, 'Invalid or expired signup state', 403);
      return;
    }
    await redisConnection.del(signupStateKey(tenantId));

    const businessToken = await exchangeEmbeddedSignupCodeForBusinessToken(input.code);
    const wabaId = await resolveWabaId(businessToken);
    const { phoneNumberId, displayPhoneNumber } = await fetchPrimaryPhoneNumber(
      wabaId,
      businessToken,
    );

    const existing = await findChannelByExternalId(tenantId, 'whatsapp', phoneNumberId);
    const registration = await ensureCloudApiRegistration(
      phoneNumberId,
      businessToken,
      existing?.metadata ?? null,
    );

    const encryptedToken = cryptoService.encrypt(businessToken);
    const metadata = buildWhatsAppChannelMetadata(
      {
        waba_id: wabaId,
        phone_number_id: phoneNumberId,
        display_phone_number: displayPhoneNumber,
        source: 'whatsapp_embedded_signup',
      },
      registration,
    );

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
      const body = err.response?.data as { error?: { message?: string; code?: number } } | undefined;
      const metaMsg = body?.error?.message?.trim();
      let graphPath = '';
      if (err.config?.url) {
        try {
          graphPath = new URL(err.config.url).pathname;
        } catch {
          graphPath = err.config.url;
        }
      }
      const hint = graphPath ? ` (${graphPath})` : '';
      sendError(
        res,
        metaMsg ? `${metaMsg}${hint}` : `WhatsApp Embedded Signup failed${hint}`,
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
