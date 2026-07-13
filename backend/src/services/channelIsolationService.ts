/**
 * P1-7 (RC-09 / SEC-2): IO wiring for multi-tenant channel-isolation.
 *
 * The pure logic (`channelBindingConflict`, `isCrossTenantConflict`, `buildChannelCollisionAlertDetails`,
 * `ChannelCollision`) lives in channelIsolation.ts and is re-exported here for convenience.
 * `reportChannelBindingConflict` is the best-effort side-effecting reporter and NEVER throws — the
 * inbound pipeline must not be blocked by a telemetry write.
 */
import * as Sentry from '@sentry/node';
import { createAIAlert } from '../db/models/aiAlert';
import { socketService } from './socketService';
import {
  MULTIPLE_CHANNELS_MATCHED_REASON,
  buildChannelCollisionAlertDetails,
  type ChannelCollision,
} from './channelIsolation';

export {
  MULTIPLE_CHANNELS_MATCHED_REASON,
  channelBindingConflict,
  isCrossTenantConflict,
  buildChannelCollisionAlertDetails,
  type ChannelCollision,
} from './channelIsolation';

/**
 * Best-effort report of a live cross-tenant channel collision. Logs a structured warning, captures
 * to Sentry (platform-side, with the full tenant set), and raises one system `ai_alert` per distinct
 * affected tenant (each business sees its account is dual-bound) with a real-time socket push.
 * NEVER throws.
 */
export async function reportChannelBindingConflict(collision: ChannelCollision): Promise<void> {
  const platformDetails = {
    type: collision.type,
    external_id: collision.externalId,
    match_count: collision.matchCount,
    tenant_ids: collision.tenantIds,
    resolved_tenant_id: collision.resolvedTenantId,
  };

  console.warn(
    '[inbound] multiple channels matched (type, external_id) — routed deterministically to earliest binding',
    platformDetails,
  );

  try {
    Sentry.captureMessage('P1-7: channel account bound to multiple tenants', {
      level: 'warning',
      extra: platformDetails,
    });
  } catch (sentryErr) {
    console.error('[inbound] Sentry captureMessage failed for channel collision', { err: sentryErr });
  }

  const tenantDetails = buildChannelCollisionAlertDetails(collision);
  await Promise.all(
    collision.tenantIds.map(async (tenantId) => {
      try {
        const alert = await createAIAlert({
          tenant_id: tenantId,
          conversation_id: null,
          message_id: null,
          reason: MULTIPLE_CHANNELS_MATCHED_REASON,
          details: tenantDetails,
        });
        socketService.emitAIAlert(tenantId, {
          ...alert,
          message_content: null,
          contact_name: 'System',
          channel_type: collision.type,
          channel_name: '—',
        });
      } catch (alertErr) {
        console.error('[inbound] channel-collision alert failed', { tenantId, err: alertErr });
      }
    }),
  );
}
