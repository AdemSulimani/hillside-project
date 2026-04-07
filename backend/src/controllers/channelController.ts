import type { Request, Response } from 'express';
import {
  deleteChannel,
  findChannelsByTenant,
  findChannelById,
  updateChannel,
} from '../db/models/channel';
import { sendError, sendSuccess } from '../utils/response';

function sanitizeChannel<T extends { access_token_encrypted: string }>(
  channel: T,
): Omit<T, 'access_token_encrypted'> {
  const { access_token_encrypted: _token, ...rest } = channel;
  return rest;
}

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const channels = await findChannelsByTenant(tenantId);
    sendSuccess(
      res,
      { channels: channels.map((channel) => sanitizeChannel(channel)) },
      'Channels retrieved successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to retrieve channels', 500, err);
  }
}

export async function destroy(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);

    const channel = await findChannelById(id, tenantId);
    if (!channel) {
      sendError(res, 'Channel not found', 404);
      return;
    }

    const deleted = await deleteChannel(id, tenantId);
    if (!deleted) {
      sendError(res, 'Channel not found', 404);
      return;
    }

    sendSuccess(res, null, 'Channel deleted successfully');
  } catch (err) {
    sendError(res, 'Failed to delete channel', 500, err);
  }
}

export async function toggleAI(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);

    const existing = await findChannelById(id, tenantId);
    if (!existing) {
      sendError(res, 'Channel not found', 404);
      return;
    }

    const updated = await updateChannel(id, tenantId, { ai_enabled: !existing.ai_enabled });
    if (!updated) {
      sendError(res, 'Channel not found', 404);
      return;
    }

    sendSuccess(
      res,
      { channel: sanitizeChannel(updated) },
      'Channel AI setting updated successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to update channel AI setting', 500, err);
  }
}
