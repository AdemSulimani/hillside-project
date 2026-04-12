import { z } from 'zod';

export const adminTenantIdSchema = z.object({
  tenantId: z.string().uuid('Invalid tenant ID'),
});
