/**
 * P1-7 (RC-09 / SEC-2): pure multi-tenant channel-isolation logic.
 *
 * No IO imports — unit-tested in isolation (see channelIsolation.test.ts). The IO wiring that turns
 * a detected collision into a log/alert/Sentry event lives in channelIsolationService.ts.
 */
import type { ChannelType } from '../db/models/channel';

/** System-alert reason: an account is bound to more than one tenant. Free-string column — no migration. */
export const MULTIPLE_CHANNELS_MATCHED_REASON = 'multiple_channels_matched';

/** Do these matched-binding tenant ids represent a cross-tenant collision (more than one tenant)? */
export function channelBindingConflict(tenantIds: string[]): boolean {
  return new Set(tenantIds).size > 1;
}

/** Guard predicate: is an existing binding owned by a tenant OTHER than the current one? */
export function isCrossTenantConflict(
  existingTenantId: string | null | undefined,
  currentTenantId: string,
): boolean {
  return existingTenantId != null && existingTenantId !== currentTenantId;
}

export interface ChannelCollision {
  type: ChannelType;
  externalId: string;
  matchCount: number;
  tenantIds: string[];
  resolvedTenantId: string;
}

/**
 * The per-tenant alert `details`. Deliberately omits the OTHER tenants' ids — a tenant-facing alert
 * should not disclose another tenant's identifier; the full set goes to the platform log/Sentry.
 * Channel type + the business's own external_id are not customer PII.
 */
export function buildChannelCollisionAlertDetails(
  collision: ChannelCollision,
): Record<string, unknown> {
  return {
    type: collision.type,
    external_id: collision.externalId,
    match_count: collision.matchCount,
  };
}
