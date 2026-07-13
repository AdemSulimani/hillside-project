/**
 * P0-6 (RC-18): pure decision core for counting the per-conversation 25/h AI-reply
 * budget against DELIVERED replies only.
 *
 * RC-18: the limiter INCRs once per BullMQ job ATTEMPT, before the enablement gates
 * (`is_active`, `ai_enabled`, `ai_paused`, `human_override`) and before the staleness /
 * reaction skips. So retries, stale-skipped jobs, disabled-AI jobs, and fairness/lock/
 * human-hold reschedules (each a fresh job) all burn budget without ever producing a
 * reply. A busy but legitimate conversation trips 25 on PHANTOM increments → persistent
 * `ai_paused` + `rate_limit_exceeded` alert → (via RC-14) permanent silence.
 *
 * The fix moves the increment to AFTER a real delivered reply, keyed idempotently on the
 * inbound message id so a BullMQ retry can never double-count, and enforces the cap with
 * a read-only pre-send check so no non-delivering job ever increments.
 *
 * This module holds the PURE, I/O-free predicates so the policy is unit-testable without
 * Redis, mirroring the P0-4 `sensitivePathFailClosed` split. The side-effectful wiring
 * (the read-only cap gate, the atomic count-once Lua, the post-send increment) lives in
 * `jobs/processAIReply.ts`, which composes these.
 *
 * The whole behaviour is gated on the `RATE_LIMIT_COUNT_DELIVERED_ONLY` flag: flag OFF
 * keeps the legacy pre-gate INCR path (and `shouldCountDeliveredReply` returns false, so
 * nothing counts post-send) byte-for-byte.
 */

/**
 * Whether the post-send increment should fire for this reply.
 *
 * Flag OFF → always false: the legacy pre-gate INCR owns counting, so there must be no
 * post-send increment (that would double-count).
 * Flag ON  → true iff the reply was actually delivered. "Not already counted" is NOT
 * decided here — it is enforced atomically by the count-once Lua marker in the caller, so
 * this predicate stays a pure function of (flag, delivered).
 */
export function shouldCountDeliveredReply(args: {
  countDeliveredOnly: boolean;
  sendSucceeded: boolean;
}): boolean {
  return args.countDeliveredOnly && args.sendSucceeded;
}

/**
 * The cap boundary for the read-only pre-send gate. `currentCount` is the number of
 * replies ALREADY delivered this rolling hour (the counter is incremented post-send), so
 * a conversation that has delivered `maxPerHour` replies is at the cap and the next new
 * reply must pause. Using `>=` here reproduces the legacy `INCR > maxPerHour` boundary:
 * both allow exactly `maxPerHour` deliveries before pausing the next one.
 */
export function isOverDeliveredRateLimit(currentCount: number, maxPerHour: number): boolean {
  return currentCount >= maxPerHour;
}

/**
 * Redis key for the per-inbound "already counted" marker. Keyed on the LOGICAL inbound id
 * (`data.messageExternalId`), which is identical across every BullMQ retry of the same
 * message — unlike the reply's own `external_message_id`, which is a synthesized
 * `ai_${uuid}` on the WhatsApp/null-send path and therefore differs per attempt. The
 * marker both (a) makes the post-send increment idempotent and (b) lets the pre-send cap
 * gate skip an inbound we've already counted (a retry that should self-heal, not re-pause).
 */
export function rateCountedMarkerKey(conversationId: string, inboundExternalId: string): string {
  return `ai_rate_counted:${conversationId}:${inboundExternalId}`;
}

/**
 * Atomic "count this delivered reply once" script.
 *
 * KEYS[1] = counter (`ai_rate_limit:{conversationId}`)
 * KEYS[2] = per-inbound marker (`ai_rate_counted:{conversationId}:{inboundExternalId}`)
 * ARGV[1] = ttl seconds (3600)
 *
 * Sets the marker with NX so a retry of the SAME inbound (or a second send within one
 * job) finds it already set and no-ops — the budget is charged exactly once per delivered
 * inbound. The rolling-1h EXPIRE is applied only on the first real increment, preserving
 * the same window semantics as the legacy pre-gate INCR script. Returns the resulting
 * counter value (or the current value on a no-op).
 *
 * Lives here (not in processAIReply.ts, whose `countDeliveredReplyOnce` evals it) so the
 * integration suite can exercise the script against a real Redis without importing the
 * whole pipeline — see `src/__integration__/rateLimitDeliveredCountLua.integration.test.ts`.
 */
export const RATE_LIMIT_DELIVERED_INCR_SCRIPT = `
local counterKey = KEYS[1]
local markerKey  = KEYS[2]
local ttl        = tonumber(ARGV[1])
if redis.call('SET', markerKey, '1', 'NX', 'EX', ttl) == false then
  return tonumber(redis.call('GET', counterKey) or '0')
end
local count = redis.call('INCR', counterKey)
if count == 1 then
  redis.call('EXPIRE', counterKey, ttl)
end
return count
`;
