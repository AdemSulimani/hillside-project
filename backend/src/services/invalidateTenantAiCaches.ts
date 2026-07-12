import { redisConnection } from '../jobs/redisConnection';
import {
  catalogGuardNamesKey,
  catalogGuardPricesKey,
} from './catalogGuardReferenceService';

/**
 * Clears all Redis caches used by AI reply assembly for this tenant.
 * Includes the tenant profile cache so business name/niche/description
 * changes are reflected immediately in prompt assembly and admin test runs,
 * and the product fallback-catalog cache so a deleted/edited product is never
 * served from the greeting/non-search fallback list after an AI-config change.
 * Also clears the hallucination-guard reference sets: the guard price set embeds
 * prices extracted from AI-config/prompt-block text, so a config edit must
 * invalidate it alongside the catalog-derived entries.
 */
export async function invalidateTenantAiCaches(tenantId: string): Promise<void> {
  await redisConnection.del(
    `ai_config:${tenantId}`,
    `tenant_prompt_blocks:${tenantId}`,
    `tenant:${tenantId}`,
    `products:${tenantId}`,
    catalogGuardPricesKey(tenantId),
    catalogGuardNamesKey(tenantId),
  );
}
