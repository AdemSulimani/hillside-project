import type { Request, Response, NextFunction } from 'express';
import { sendError } from '../utils/response';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error('Unhandled error:', err);

  const statusCode =
    'statusCode' in err ? (err as Error & { statusCode: number }).statusCode : 500;

  // Never surface raw internal error messages (DB errors, stack details, library
  // internals) to clients for server-side faults. Client errors (4xx) keep their
  // human-readable message because those are intentional, safe validation/usage hints.
  const isServerError = statusCode >= 500;
  const safeMessage =
    isServerError && process.env.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : err.message || 'Internal Server Error';

  sendError(res, safeMessage, statusCode, err);
}
