import type { Request, Response } from 'express';
import {
  countUnreadAIAlertsForTenant,
  findAIAlertByIdForTenant,
  listAIAlertsForTenant,
  markAllUnreadAIAlertsAsReadForTenant,
  updateAIAlertStatus,
} from '../db/models/aiAlert';
import { findConversationByIdForTenant, setConversationAiPaused } from '../db/models/conversation';
import { socketService } from '../services/socketService';
import { sendError, sendPaginated, sendSuccess } from '../utils/response';
import type { AIAlertListQuery, ResolveAIAlertBody } from '../validators/aiAlert';

export async function index(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const query = (req.validated?.query ?? req.query) as unknown as AIAlertListQuery;

    const { rows, total } = await listAIAlertsForTenant({
      tenantId,
      status: query.status,
      page: query.page,
      limit: query.limit,
    });

    sendPaginated(res, rows, query.page, query.limit, total, 'AI alerts retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to retrieve AI alerts', 500, err);
  }
}

export async function unreadCount(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const count = await countUnreadAIAlertsForTenant(tenantId);
    sendSuccess(res, { count }, 'Unread AI alert count retrieved successfully');
  } catch (err) {
    sendError(res, 'Failed to count unread AI alerts', 500, err);
  }
}

export async function markAsRead(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };

    const existing = await findAIAlertByIdForTenant(id, tenantId);
    if (!existing) {
      sendError(res, 'Alert not found', 404);
      return;
    }
    if (existing.status === 'resolved') {
      sendError(res, 'Cannot mark a resolved alert as read', 400);
      return;
    }
    if (existing.status === 'read') {
      sendSuccess(res, { alert: existing }, 'Alert already read');
      return;
    }

    const updated = await updateAIAlertStatus(id, tenantId, 'read');
    if (existing.conversation_id) {
      socketService.emitConversationUpdated(tenantId, existing.conversation_id);
    }
    sendSuccess(res, { alert: updated }, 'Alert marked as read');
  } catch (err) {
    sendError(res, 'Failed to update alert', 500, err);
  }
}

export async function markAllRead(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const updated = await markAllUnreadAIAlertsAsReadForTenant(tenantId);
    sendSuccess(res, { updated }, 'All unread alerts marked as read');
  } catch (err) {
    sendError(res, 'Failed to mark alerts as read', 500, err);
  }
}

export async function resolve(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const { id } = (req.validated?.params ?? req.params) as { id: string };
    const body = (req.validated?.body ?? req.body) as ResolveAIAlertBody;

    const existing = await findAIAlertByIdForTenant(id, tenantId);
    if (!existing) {
      sendError(res, 'Alert not found', 404);
      return;
    }

    if (body.resume_ai === true) {
      if (!existing.conversation_id) {
        sendError(res, 'This alert is not tied to a conversation', 400);
        return;
      }
      const convo = await findConversationByIdForTenant(existing.conversation_id, tenantId);
      if (!convo) {
        sendError(res, 'Conversation not found', 404);
        return;
      }
    }

    let alert = existing;
    if (existing.status !== 'resolved') {
      const updated = await updateAIAlertStatus(id, tenantId, 'resolved');
      if (!updated) {
        sendError(res, 'Failed to resolve alert', 500);
        return;
      }
      alert = updated;
    }

    if (body.resume_ai === true && existing.conversation_id) {
      await setConversationAiPaused(existing.conversation_id, tenantId, false);
    }

    if (existing.conversation_id) {
      socketService.emitConversationUpdated(tenantId, existing.conversation_id);
    }

    sendSuccess(res, { alert, resume_ai: body.resume_ai === true }, 'Alert resolved');
  } catch (err) {
    sendError(res, 'Failed to resolve alert', 500, err);
  }
}
