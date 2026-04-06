import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';

export function ensureOnboarded(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.tenantId) {
    sendError(res, 'onboarding_required', 403);
    return;
  }
  next();
}
