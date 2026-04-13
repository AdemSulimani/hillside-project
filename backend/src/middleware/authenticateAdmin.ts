import type { Request, Response, NextFunction } from 'express';
import { verifyAdminAccessToken } from '../services/adminTokenService';
import { verifyAccessToken } from '../services/tokenService';
import { sendError } from '../utils/response';

declare global {
  namespace Express {
    interface Request {
      admin?: {
        platformOwnerId: string;
        email: string;
      };
    }
  }
}

export function authenticateAdmin(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendError(res, 'Authentication required', 401);
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = verifyAdminAccessToken(token);
    req.admin = { platformOwnerId: payload.platformOwnerId, email: payload.email };
    next();
  } catch (err) {
    if (err instanceof Error && err.message.includes('ADMIN_JWT_SECRET')) {
      sendError(res, 'Admin authentication is not configured', 503, err);
      return;
    }
    try {
      verifyAccessToken(token);
      sendError(
        res,
        'A business user token cannot access platform admin routes. Sign in at /admin/login.',
        403,
      );
      return;
    } catch {
      sendError(res, 'Invalid or expired admin token', 401);
    }
  }
}
