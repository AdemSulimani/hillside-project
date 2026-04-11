import pool from '../db/pool';

export const ANALYTICS_EVENT_TYPES = [
  'message_received',
  'ai_reply_sent',
  'human_reply_sent',
  'order_created',
  'order_confirmed',
  'feedback_submitted',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

/**
 * Inserts one analytics row. Swallows errors so callers are not blocked;
 * failures are logged to stderr.
 */
export async function logEvent(
  tenantId: string,
  eventType: AnalyticsEventType | string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO analytics_events (tenant_id, event_type, metadata)
       VALUES ($1, $2, $3::jsonb)`,
      [tenantId, eventType, JSON.stringify(metadata)],
    );
  } catch (err) {
    console.error('[analytics] logEvent failed', { tenantId, eventType, err });
  }
}
