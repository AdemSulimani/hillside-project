import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../services/tokenService';
import { sendError } from '../utils/response';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        tenantId: string | null;
      };
    }
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Authentication required', 401);
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAccessToken(token);
    req.user = { userId: payload.userId, tenantId: payload.tenantId };
    next();
  } catch {
    sendError(res, 'Invalid or expired token', 401);
  }
}
