import type { Request, Response } from 'express';
import {
  countUnreadAIAlertsForTenant,
  findAIAlertByIdForTenant,
  hasOpenSensitiveAlertForConversation,
  listAIAlertsForTenant,
  markAllUnreadAIAlertsAsReadForTenant,
  updateAIAlertStatus,
} from '../db/models/aiAlert';
import { findConversationByIdForTenant, setConversationAiPaused } from '../db/models/conversation';
import { socketService } from '../services/socketService';
import { sendError, sendPaginated, sendSuccess } from '../utils/response';
import { canDefaultResumeConversation, shouldResumeOnResolve } from '../services/aiResumePolicy';
import type { AIAlertListQuery, ResolveAIAlertBody } from '../validators/aiAlert';

/**
 * P0-5 (RC-14): when ON, resolving a NON-sensitive alert without an explicit `resume_ai`
 * resumes the AI (ending the permanent-silence dead-end). Sensitive reasons, manual and
 * legacy pauses (`ai_paused_at` NULL), and conversations with another open sensitive
 * alert still require an explicit resume. Defaults OFF: flag-off preserves the legacy
 * resume-only-via-`resume_ai:true` behaviour byte-for-byte.
 */
const AI_AUTO_RESUME =
  (process.env.AI_AUTO_RESUME ?? 'false').trim().toLowerCase() === 'true';

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

    // P0-5 (RC-14): decide whether to resume the AI. Explicit resume_ai always wins; when
    // omitted, AI_AUTO_RESUME default-resumes a NON-sensitive alert. Flag off → resume
    // only on explicit resume_ai:true (legacy).
    const resume = shouldResumeOnResolve(existing.reason, body.resume_ai, AI_AUTO_RESUME);

    // An EXPLICIT resume of a system alert with no conversation is a user error (preserve
    // the legacy 400). A default (omitted) resume of such an alert simply resolves it
    // without resuming — there is no conversation to resume.
    if (body.resume_ai === true && !existing.conversation_id) {
      sendError(res, 'This alert is not tied to a conversation', 400);
      return;
    }

    let willResume = resume && existing.conversation_id != null;
    if (willResume) {
      const convo = await findConversationByIdForTenant(existing.conversation_id!, tenantId);
      if (!convo) {
        // Explicit resume of a missing conversation stays a hard error (legacy 404); a
        // default resolve just resolves the alert without resuming.
        if (body.resume_ai === true) {
          sendError(res, 'Conversation not found', 404);
          return;
        }
        willResume = false;
      } else if (body.resume_ai !== true) {
        // Default (omitted resume_ai) resume is additionally guarded by the CONVERSATION's
        // pause state: never un-pause a manual/legacy pause (ai_paused_at NULL) and never
        // resume past another still-open sensitive alert (a human may be mid-refund even
        // though THIS alert is non-sensitive). The sensitive-alert probe fails safe: on
        // error, treat as "has one" and stay paused. Explicit resume_ai:true bypasses all
        // of this — the human's decision wins (legacy).
        const hasOpenSensitiveAlert = await hasOpenSensitiveAlertForConversation(
          existing.conversation_id!,
          tenantId,
        ).catch(() => true);
        willResume = canDefaultResumeConversation({
          aiPaused: convo.ai_paused,
          aiPausedAt: convo.ai_paused_at,
          hasOpenSensitiveAlert,
        });
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

    if (willResume && existing.conversation_id) {
      await setConversationAiPaused(existing.conversation_id, tenantId, false);
    }

    if (existing.conversation_id) {
      socketService.emitConversationUpdated(tenantId, existing.conversation_id);
    }

    sendSuccess(res, { alert, resume_ai: willResume }, 'Alert resolved');
  } catch (err) {
    sendError(res, 'Failed to resolve alert', 500, err);
  }
}
