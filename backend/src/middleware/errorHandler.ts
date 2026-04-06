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

  sendError(res, err.message || 'Internal Server Error', statusCode, err);
}
