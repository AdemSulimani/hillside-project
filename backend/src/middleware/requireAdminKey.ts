import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

function adminKeyMatches(provided: string, expected: string): boolean {
  const ah = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const bh = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

/**
 * Protects admin-only routes. Send the same value as `ADMIN_KEY` in the `X-Admin-Key` header.
 */
export function requireAdminKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.ADMIN_KEY?.trim();
  if (!expected) {
    res.status(503).json({ success: false, message: 'Admin dashboard is not configured (ADMIN_KEY).' });
    return;
  }

  const provided = req.header('x-admin-key')?.trim();
  if (!provided) {
    res.status(401).json({ success: false, message: 'Missing X-Admin-Key header.' });
    return;
  }

  if (!adminKeyMatches(provided, expected)) {
    res.status(401).json({ success: false, message: 'Unauthorized.' });
    return;
  }

  next();
}
