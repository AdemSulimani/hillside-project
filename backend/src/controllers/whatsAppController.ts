import type { Request, Response } from 'express';
import axios from 'axios';
import { createChannel, findChannelByExternalId, updateChannel } from '../db/models/channel';
import { cryptoService } from '../services/cryptoService';
import type { WhatsAppConnectInput } from '../validators/channel';
import { sendError, sendSuccess } from '../utils/response';

const META_API_BASE = 'https://graph.facebook.com/v23.0';

export async function connect(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const input = req.body as WhatsAppConnectInput;

    const verifyResp = await axios.get<{ id: string; display_phone_number?: string }>(
      `${META_API_BASE}/${input.phoneNumberId}`,
      {
        params: { fields: 'id,display_phone_number' },
        headers: {
          Authorization: `Bearer ${input.accessToken}`,
        },
      },
    );

    const externalId = verifyResp.data.id;
    const channelName =
      input.name ||
      verifyResp.data.display_phone_number ||
      `WhatsApp ${externalId}`;
    const encryptedToken = cryptoService.encrypt(input.accessToken);

    const existing = await findChannelByExternalId(tenantId, 'whatsapp', externalId);
    if (existing) {
      const updated = await updateChannel(existing.id, tenantId, {
        name: channelName,
        access_token_encrypted: encryptedToken,
        connection_method: 'manual',
        metadata: {
          phone_number_id: externalId,
          display_phone_number: verifyResp.data.display_phone_number ?? null,
          source: 'manual_whatsapp_connect',
        },
      });
      if (!updated) {
        sendError(res, 'Failed to update WhatsApp channel', 500);
        return;
      }

      sendSuccess(res, { channelId: updated.id }, 'WhatsApp channel updated successfully');
      return;
    }

    const created = await createChannel({
      tenant_id: tenantId,
      type: 'whatsapp',
      name: channelName,
      external_id: externalId,
      access_token_encrypted: encryptedToken,
      connection_method: 'manual',
      metadata: {
        phone_number_id: externalId,
        display_phone_number: verifyResp.data.display_phone_number ?? null,
        source: 'manual_whatsapp_connect',
      },
    });

    sendSuccess(res, { channelId: created.id }, 'WhatsApp channel connected successfully', 201);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      sendError(
        res,
        'Failed to verify WhatsApp credentials',
        400,
        err.response?.data ?? err.message,
      );
      return;
    }

    sendError(res, 'Failed to connect WhatsApp channel', 500, err);
  }
}
