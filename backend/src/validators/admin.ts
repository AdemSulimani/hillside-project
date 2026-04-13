import { z } from 'zod';

export const adminTenantIdSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
});

export const adminTenantIdParamsSchema = adminTenantIdSchema;

export const adminLoginBodySchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(1, 'Password is required'),
});

export type AdminLoginBody = z.infer<typeof adminLoginBodySchema>;

export const adminBusinessListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type AdminBusinessListQuery = z.infer<typeof adminBusinessListQuerySchema>;

export const adminCommissionableOrdersQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(20),
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .refine(
    (q) =>
      (q.period_start === undefined && q.period_end === undefined) ||
      (q.period_start !== undefined && q.period_end !== undefined),
    { message: 'Provide both period_start and period_end, or neither', path: ['period_end'] },
  )
  .refine(
    (q) =>
      !q.period_start || !q.period_end || q.period_end >= q.period_start,
    { message: 'period_end must be on or after period_start', path: ['period_end'] },
  );

export type AdminCommissionableOrdersQuery = z.infer<typeof adminCommissionableOrdersQuerySchema>;

export const adminOrderIdParamsSchema = z.object({
  orderId: z.string().uuid('Invalid order ID'),
});

export const adminCommissionStatusPatchBodySchema = z.object({
  commission_status: z.enum(['unpaid', 'billed', 'paid']),
});

export type AdminCommissionStatusPatchBody = z.infer<typeof adminCommissionStatusPatchBodySchema>;

export const adminGenerateReportBodySchema = z
  .object({
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'period_start must be YYYY-MM-DD'),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'period_end must be YYYY-MM-DD'),
  })
  .refine((b) => b.period_end >= b.period_start, {
    path: ['period_end'],
    message: 'period_end must be on or after period_start',
  });

export type AdminGenerateReportBody = z.infer<typeof adminGenerateReportBodySchema>;

/** Same shape as generate-report (inclusive date range). */
export const adminMarkCommissionPeriodBodySchema = adminGenerateReportBodySchema;
export type AdminMarkCommissionPeriodBody = z.infer<typeof adminMarkCommissionPeriodBodySchema>;

export const adminPeriodQueryRequiredSchema = z
  .object({
    period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .refine((b) => b.period_end >= b.period_start, {
    path: ['period_end'],
    message: 'period_end must be on or after period_start',
  });

export type AdminPeriodQueryRequired = z.infer<typeof adminPeriodQueryRequiredSchema>;

export const adminReportIdParamsSchema = z.object({
  reportId: z.string().uuid('Invalid report ID'),
});

export const adminReportStatusPatchBodySchema = z.object({
  status: z.enum(['unpaid', 'billed', 'paid']),
});

export type AdminReportStatusPatchBody = z.infer<typeof adminReportStatusPatchBodySchema>;
