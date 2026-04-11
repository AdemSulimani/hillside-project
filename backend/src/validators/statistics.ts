import { z } from 'zod';

export const statisticsSummaryQuerySchema = z
  .object({
    startDate: z.coerce.date(),
    endDate: z.coerce.date(),
  })
  .refine((q) => q.startDate.getTime() <= q.endDate.getTime(), {
    message: 'startDate must be before or equal to endDate',
    path: ['endDate'],
  });

export type StatisticsSummaryQuery = z.infer<typeof statisticsSummaryQuerySchema>;
