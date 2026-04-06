import type { Request } from 'express';
import type { ParamsDictionary } from 'express-serve-static-core';
import type { ParsedQs } from 'qs';

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface PaginatedResponse<T = unknown> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface ValidatedRequest<
  TBody = unknown,
  TParams extends ParamsDictionary = ParamsDictionary,
  TQuery extends ParsedQs = ParsedQs,
> extends Request<TParams, unknown, TBody, TQuery> {}
