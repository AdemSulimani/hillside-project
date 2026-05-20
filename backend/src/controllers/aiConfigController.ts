import type { Request, Response } from 'express';
import { ensureAIConfigForTenant } from '../db/models/aiConfig';
import { sendSuccess, sendError } from '../utils/response';

/** Narrow fields exposed to CRM tenants — prompt text and mutable AI settings are admin-only. */
export async function show(req: Request, res: Response): Promise<void> {
  try {
    const tenantId = req.user!.tenantId!;
    const config = await ensureAIConfigForTenant(tenantId);

    sendSuccess(res, {
      is_active: config.is_active,
      custom_model_id: config.custom_model_id,
      feedback_count: config.feedback_count,
    });
  } catch (err) {
    sendError(res, 'Failed to fetch AI configuration', 500, err);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  sendError(
    res,
    'AI configuration is managed by the platform administrator. Contact support if you need changes.',
    403,
  );
}

export async function test(req: Request, res: Response): Promise<void> {
  sendError(
    res,
    'AI testing is available from the admin dashboard. Business users cannot run test prompts.',
    403,
  );
}
