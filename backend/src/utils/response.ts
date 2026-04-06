import type { Response } from 'express';
import type { PaginatedResponse } from '../types';

export function sendSuccess<T>(
  res: Response,
  data: T,
  message = 'Success',
  statusCode = 200,
): void {
  res.status(statusCode).json({
    success: true,
    data,
    message,
  });
}

export function sendError(
  res: Response,
  message = 'Internal Server Error',
  statusCode = 500,
  error?: unknown,
): void {
  const payload: Record<string, unknown> = {
    success: false,
    message,
  };

  if (error) {
    if (error instanceof Error) {
      if (process.env.NODE_ENV === 'development') {
        payload.error = error.message;
      }
    } else {
      payload.error = error;
    }
  }

  res.status(statusCode).json(payload);
}

export function sendPaginated<T>(
  res: Response,
  data: T[],
  page: number,
  limit: number,
  total: number,
  message = 'Success',
): void {
  const body: PaginatedResponse<T> = {
    success: true,
    data,
    message,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  };

  res.status(200).json(body);
}
