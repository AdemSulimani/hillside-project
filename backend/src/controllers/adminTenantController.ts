import type { Request, Response } from 'express';
import { tenantCleanupService } from '../services/tenantCleanupService';
import { sendError, sendSuccess } from '../utils/response';

export async function destroyTenant(req: Request, res: Response): Promise<void> {
  try {
    const { tenantId } = req.params as { tenantId: string };
    const deleted = await tenantCleanupService.deleteTenant(tenantId);
    if (!deleted) {
      sendError(res, 'Tenant not found', 404);
      return;
    }
    sendSuccess(res, { tenantId }, 'Tenant and all related data were deleted.');
  } catch (err) {
    sendError(res, 'Failed to delete tenant', 500, err);
  }
}
