import type { Request, Response } from 'express';
import { findAIConfigByTenant, updateAIConfig } from '../db/models/aiConfig';
import {
  findConversationByIdForTenant,
  toggleAiPaused,
  findPausedConversationsByTenant,
} from '../db/models/conversation';
import { sendError, sendSuccess } from '../utils/response';

export async function globalStatus(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const config = await findAIConfigByTenant(tenantId);

    sendSuccess(res, { is_active: config?.is_active ?? false }, 'Global AI status retrieved');
  } catch (err) {
    sendError(res, 'Failed to retrieve global AI status', 500, err);
  }
}

export async function toggleGlobal(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const config = await findAIConfigByTenant(tenantId);

    if (!config) {
      sendError(res, 'AI configuration not found. Complete onboarding first.', 404);
      return;
    }

    const updated = await updateAIConfig(tenantId, { is_active: !config.is_active });

    sendSuccess(
      res,
      { is_active: updated?.is_active ?? false },
      'Global AI setting toggled successfully',
    );
  } catch (err) {
    sendError(res, 'Failed to toggle global AI setting', 500, err);
  }
}

export async function toggleConversation(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const validated = req.validated?.params as { id: string } | undefined;
    const id = validated?.id ?? (req.params.id as string);

    const existing = await findConversationByIdForTenant(id, tenantId);
    if (!existing) {
      sendError(res, 'Conversation not found', 404);
      return;
    }

    const updated = await toggleAiPaused(id, tenantId);
    if (!updated) {
      sendError(res, 'Failed to update conversation', 500);
      return;
    }

    sendSuccess(
      res,
      { id: updated.id, ai_paused: updated.ai_paused },
      `Conversation AI ${updated.ai_paused ? 'paused' : 'resumed'} successfully`,
    );
  } catch (err) {
    sendError(res, 'Failed to toggle conversation AI setting', 500, err);
  }
}

export async function pausedConversations(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const conversations = await findPausedConversationsByTenant(tenantId);

    sendSuccess(res, { conversations }, 'Paused conversations retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve paused conversations', 500, err);
  }
}
