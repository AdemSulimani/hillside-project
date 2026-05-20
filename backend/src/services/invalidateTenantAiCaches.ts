import { redisConnection } from '../jobs/redisConnection';

/** Clears Redis caches used by AI reply assembly for this tenant. */
export async function invalidateTenantAiCaches(tenantId: string): Promise<void> {
  await redisConnection.del(`ai_config:${tenantId}`, `tenant_prompt_blocks:${tenantId}`);
}
