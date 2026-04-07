import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { createChannel, findChannelByExternalId, updateChannel } from '../db/models/channel';
import { cryptoService } from '../services/cryptoService';
import { sendError, sendSuccess } from '../utils/response';

const META_API_BASE = 'https://graph.facebook.com/v23.0';

interface OAuthStatePayload {
  tenantId: string;
  type?: 'facebook' | 'instagram';
}

interface MetaTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
}

interface MetaPage {
  id: string;
  name: string;
  access_token?: string;
  instagram_business_account?: {
    id: string;
  };
}

function getOAuthConfig() {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  const jwtSecret = process.env.JWT_SECRET;
  const callbackUrl = process.env.META_REDIRECT_URI || `${frontendUrl}/api/oauth/meta/callback`;

  if (!appId || !appSecret || !jwtSecret) {
    throw new Error('META_APP_ID, META_APP_SECRET, and JWT_SECRET are required');
  }

  return { appId, appSecret, callbackUrl, jwtSecret };
}

function buildStateToken(
  tenantId: string,
  jwtSecret: string,
  type?: 'facebook' | 'instagram',
): string {
  return jwt.sign({ tenantId, type } satisfies OAuthStatePayload, jwtSecret, { expiresIn: '15m' });
}

function verifyStateToken(state: string, jwtSecret: string): OAuthStatePayload {
  return jwt.verify(state, jwtSecret) as OAuthStatePayload;
}

function getScopesForType(type: 'facebook' | 'instagram'): string {
  if (type === 'instagram') {
    return [
      'pages_show_list',
      'pages_manage_metadata',
    ].join(',');
  }

  return [
    'pages_show_list',
    'pages_manage_metadata',
    'pages_messaging',
  ].join(',');
}

export async function redirect(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { appId, callbackUrl, jwtSecret } = getOAuthConfig();

    const typeQuery = req.query.type as string | undefined;
    const requestedType = typeQuery === 'instagram' ? 'instagram' : 'facebook';
    const state = buildStateToken(tenantId, jwtSecret, requestedType);
    const scopes = getScopesForType(requestedType);

    const url = new URL('https://www.facebook.com/v23.0/dialog/oauth');
    url.searchParams.set('client_id', appId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', scopes);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    sendSuccess(res, { url: url.toString() }, 'Meta OAuth URL generated successfully');
  } catch (err) {
    sendError(res, 'Failed to generate Meta OAuth URL', 500, err);
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

    const shortTokenResp = await axios.get<MetaTokenResponse>(`${META_API_BASE}/oauth/access_token`, {
      params: {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: callbackUrl,
        code,
      },
    });

    const shortLivedToken = shortTokenResp.data.access_token;

    const longTokenResp = await axios.get<MetaTokenResponse>(`${META_API_BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortLivedToken,
      },
    });

    const longLivedToken = longTokenResp.data.access_token;

    const pagesResp = await axios.get<{ data: MetaPage[] }>(`${META_API_BASE}/me/accounts`, {
      params: {
        access_token: longLivedToken,
        fields: 'id,name,access_token,instagram_business_account{id}',
      },
    });

    const pages = pagesResp.data.data ?? [];
    for (const page of pages) {
      const tokenToStore = page.access_token || longLivedToken;
      const encrypted = cryptoService.encrypt(tokenToStore);

      const existingFacebook = await findChannelByExternalId(parsedState.tenantId, 'facebook', page.id);
      if (existingFacebook) {
        await updateChannel(existingFacebook.id, parsedState.tenantId, {
          name: page.name,
          access_token_encrypted: encrypted,
          metadata: { source: 'meta_oauth' },
        });
      } else {
        await createChannel({
          tenant_id: parsedState.tenantId,
          type: 'facebook',
          name: page.name,
          external_id: page.id,
          access_token_encrypted: encrypted,
          metadata: { source: 'meta_oauth' },
        });
      }

      const igId = page.instagram_business_account?.id;
      if (igId) {
        const existingInstagram = await findChannelByExternalId(parsedState.tenantId, 'instagram', igId);
        if (existingInstagram) {
          await updateChannel(existingInstagram.id, parsedState.tenantId, {
            name: `${page.name} (Instagram)`,
            access_token_encrypted: encrypted,
            metadata: { source_page_id: page.id, source: 'meta_oauth' },
          });
        } else {
          await createChannel({
            tenant_id: parsedState.tenantId,
            type: 'instagram',
            name: `${page.name} (Instagram)`,
            external_id: igId,
            access_token_encrypted: encrypted,
            metadata: { source_page_id: page.id, source: 'meta_oauth' },
          });
        }
      }
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const type = parsedState.type ?? 'facebook';
    const redirectUrl = new URL('/channels', frontendUrl);
    redirectUrl.searchParams.set('status', 'connected');
    redirectUrl.searchParams.set('type', type);
    redirectUrl.searchParams.set('count', String(pages.length));
    res.redirect(302, redirectUrl.toString());
  } catch (err) {
    if (axios.isAxiosError(err)) {
      sendError(
        res,
        'Meta OAuth callback failed',
        400,
        err.response?.data ?? err.message,
      );
      return;
    }

    sendError(res, 'Meta OAuth callback failed', 500, err);
  }
}
