import { redisConnection } from '../jobs/redisConnection';

/**
 * Clears all Redis caches used by AI reply assembly for this tenant.
 * Includes the tenant profile cache so business name/niche/description
 * changes are reflected immediately in prompt assembly and admin test runs,
 * and the product fallback-catalog cache so a deleted/edited product is never
 * served from the greeting/non-search fallback list after an AI-config change.
 */
export async function invalidateTenantAiCaches(tenantId: string): Promise<void> {
  await redisConnection.del(
    `ai_config:${tenantId}`,
    `tenant_prompt_blocks:${tenantId}`,
    `tenant:${tenantId}`,
    `products:${tenantId}`,
  );
}
