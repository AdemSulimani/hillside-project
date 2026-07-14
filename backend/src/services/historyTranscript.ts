/**
 * P2-3 (RC-16) — the delivery-filtered transcript predicates. History assembly used to map EVERY
 * non-customer row to `assistant` regardless of `flagged` or send status, so the model
 * re-conditioned on (a) replies that were never delivered (send failed) and (b) its own flagged
 * low-quality replies, as if they were authoritative prior statements — compounding drift.
 *
 * Two pure predicates, network-free and unit-testable (mirrors `orderStageMachine.ts` /
 * `groundingGate.ts`). The role mapper takes the canned-copy check as an injected predicate so this
 * module stays pure and free of any dependency on the reply orchestrator.
 *
 * DELIVERY-MARKER CONSTRAINT: there is no positive `delivered` column on `messages`. `send_status`
 * is written to `'failed'` ONLY (on a send error, both the staged and legacy paths); a successful
 * outbound, any inbound, and a not-yet-attempted row all read `NULL`. So the exclusion keys on
 * `send_status === 'failed'` and NEVER on `!= 'delivered'` (no such value exists). A legacy row
 * with an unreliable marker is therefore treated as delivered — kept — unless explicitly flagged.
 */

/** The subset of a message row the transcript predicates read. */
export interface HistoryRowLike {
  sent_by: string;
  flagged?: boolean | null;
  send_status?: string | null;
  content?: string | null;
}

export type HistoryRole = 'user' | 'assistant' | 'system';

/**
 * Whether a row belongs in the reassembled history at all. Drops ONLY a non-customer row that was
 * never delivered (`send_status === 'failed'`). Customer (inbound) rows are always kept; `NULL`
 * send status is ambiguous and treated as delivered.
 */
export function keepMessageInHistory(msg: HistoryRowLike): boolean {
  if (msg.sent_by === 'customer') return true;
  return msg.send_status !== 'failed';
}

/**
 * The chat role for a KEPT row (apply `keepMessageInHistory` first). Customer → `user`. A delivered
 * non-customer row is `assistant` EXCEPT when it is a flagged low-quality reply or canned
 * holding/escalation/procedural copy — those were delivered to the customer but must not be fed
 * back as authoritative assistant grounding, so they become `system` (labeled context only).
 */
export function historyRoleFor(
  msg: HistoryRowLike,
  isCannedHoldingCopy: (content: string) => boolean,
): HistoryRole {
  if (msg.sent_by === 'customer') return 'user';
  if (msg.flagged === true) return 'system';
  if (isCannedHoldingCopy(msg.content ?? '')) return 'system';
  return 'assistant';
}
