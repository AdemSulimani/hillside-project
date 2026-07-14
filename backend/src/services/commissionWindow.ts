/**
 * P2-2 (RC-22) — pure builder for the AI-order commission human-participation window query.
 *
 * Extracted so the RC-22 anchoring change is unit-testable without a DB: when `anchorOnOrderEvent`
 * is ON and an `orderEventAt` timestamp is supplied, the window anchors on that STORED consent
 * timestamp (`$4`) instead of `NOW()` and bounds `recent_messages` at it — so a retry / late run
 * (or a human reply landing during retry latency, AFTER the order) can't flip is_commissionable.
 * Flag-off reproduces the legacy `NOW()`-relative query byte-for-byte (3 params, no upper bound).
 */
export interface CommissionWindowQuery {
  text: string;
  values: Array<string | number | Date>;
}

export function buildCommissionWindowQuery(args: {
  conversationId: string;
  tenantId: string;
  sessionGapHours: number;
  orderEventAt: Date | null;
  anchorOnOrderEvent: boolean;
}): CommissionWindowQuery {
  const useAnchor = args.anchorOnOrderEvent && args.orderEventAt != null;
  const anchor = useAnchor ? '$4::timestamptz' : 'NOW()';
  const upperBound = useAnchor ? `AND created_at <= ${anchor}` : '';
  const values: Array<string | number | Date> = [
    args.conversationId,
    args.tenantId,
    args.sessionGapHours,
  ];
  if (useAnchor && args.orderEventAt) values.push(args.orderEventAt);

  const text = `WITH recent_messages AS (
       SELECT created_at, direction, sent_by
       FROM messages
       WHERE conversation_id = $1
         AND tenant_id = $2
         AND created_at > ${anchor} - INTERVAL '30 days'
         ${upperBound}
     ),
     gaps AS (
       SELECT created_at,
              LAG(created_at) OVER (ORDER BY created_at) AS prev_created_at
       FROM recent_messages
     ),
     session_start AS (
       SELECT COALESCE(MAX(created_at), ${anchor} - INTERVAL '30 days') AS started_at
       FROM gaps
       WHERE prev_created_at IS NULL
          OR created_at - prev_created_at > ($3::numeric * INTERVAL '1 hour')
     ),
     previous_order AS (
       SELECT MAX(created_at) AS last_order_at
       FROM orders
       WHERE conversation_id = $1 AND tenant_id = $2
     )
     SELECT EXISTS (
       SELECT 1
       FROM recent_messages m
       CROSS JOIN session_start s
       CROSS JOIN previous_order p
       WHERE m.direction = 'outbound'
         AND m.sent_by = 'human'
         AND m.created_at >= GREATEST(s.started_at, COALESCE(p.last_order_at, s.started_at))
     ) AS human_in_window`;

  return { text, values };
}
