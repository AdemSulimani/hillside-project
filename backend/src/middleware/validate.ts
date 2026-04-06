import type { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { sendError } from '../utils/response';

type RequestField = 'body' | 'params' | 'query';

declare global {
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        params?: unknown;
        query?: unknown;
      };
    }
  }
}

interface ValidationTarget {
  body?: ZodSchema;
  params?: ZodSchema;
  query?: ZodSchema;
}

export function validate(schema: ValidationTarget) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fields: RequestField[] = ['body', 'params', 'query'];
    const errors: Record<string, unknown> = {};

    if (!req.validated) req.validated = {};

    for (const field of fields) {
      const fieldSchema = schema[field];
      if (!fieldSchema) continue;

      const result = fieldSchema.safeParse(req[field]);
      if (!result.success) {
        errors[field] = result.error.flatten().fieldErrors;
      } else {
        req.validated[field] = result.data;
        if (field === 'body') {
          req.body = result.data;
        }
      }
    }

    if (Object.keys(errors).length > 0) {
      sendError(res, 'Validation failed', 400, errors);
      return;
    }

    next();
  };
}

export function validateBody(schema: ZodSchema) {
  return validate({ body: schema });
}

export function validateParams(schema: ZodSchema) {
  return validate({ params: schema });
}

export function validateQuery(schema: ZodSchema) {
  return validate({ query: schema });
}
