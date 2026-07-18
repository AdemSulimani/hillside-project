/**
 * P3-2 Step 9a — per-tenant concurrency slots as LEASES, not a counter.
 *
 * THE DEFECT IN THE COUNTER. `ai_active_jobs:{tenantId}` is `INCR`ed on entry and `DECR`ed in the
 * job's `finally`, with `EXPIRE key 300` applied ONLY when the counter reads 1:
 *
 *     const activeCount = await redisConnection.incr(tenantActiveKey);
 *     if (activeCount === 1) await redisConnection.expire(tenantActiveKey, 300);
 *
 * So the TTL is armed once and never refreshed. With three jobs in flight past the 300 s mark — very
 * reachable, since `OPENAI_CALL_TIMEOUT_MS` and `OPENAI_TURN_DEADLINE_MS` both default to 0/off and
 * one call can run 60 s × 4 SDK attempts — the key simply expires mid-flight. Then:
 *
 *   1. the next job `INCR`s a MISSING key to 1 and re-arms the TTL;
 *   2. the three original jobs each `DECR`, driving the counter to -2;
 *   3. `DECR` on a missing key recreates it with NO TTL, and the release path never calls `EXPIRE`.
 *
 * The tenant's counter is now negative and permanent, so `activeCount > cap` is false for the next
 * several jobs and the fairness cap is silently DISABLED — for exactly the burst-traffic tenant it
 * exists to contain.
 *
 * WHY NOT "JUST REFRESH THE TTL". That trades a self-healing bug for a permanent one: the TTL is the
 * only thing that recovers a slot leaked by a hard crash (SIGKILL between INCR and the `finally`),
 * so refreshing it on every acquire means one crash can wedge a tenant's capacity until someone
 * deletes the key by hand.
 *
 * THE LEASE. A sorted set keyed by tenant, member = a per-job token, score = absolute expiry in ms.
 * Every acquire first drops expired members, so each lease expires INDEPENDENTLY: a crashed job
 * costs one slot for one TTL instead of corrupting the count, the cardinality can never go negative,
 * and a normal release is an exact `ZREM` of the token that job owns.
 *
 * The Lua lives here as an exported constant (mirroring `rateLimitDeliveredCount.ts`) so the
 * integration suite can exercise it against a real Redis without importing the whole pipeline.
 */

export function tenantSlotKey(tenantId: string): string {
  return `ai_slots:${tenantId}`;
}

/**
 * A token unique to one job attempt. Includes the conversation for debuggability — `ZRANGE` on a
 * wedged tenant then shows WHICH conversations hold its slots, which the bare counter never could.
 */
export function tenantSlotMember(conversationId: string, token: string): string {
  return `${conversationId}:${token}`;
}

/**
 * Acquire a slot.
 *
 * KEYS[1] = `ai_slots:{tenantId}`
 * ARGV[1] = now (epoch ms)
 * ARGV[2] = lease TTL (ms)
 * ARGV[3] = member
 * ARGV[4] = max concurrent slots
 *
 * Returns `{acquired (1|0), active cardinality after the attempt}`.
 *
 * Ordering matters: prune BEFORE counting, or a tenant whose jobs all crashed stays at its cap until
 * the whole key expires. The key-level PEXPIRE is a backstop with generous headroom so the key
 * itself disappears once a tenant goes quiet, without ever truncating a live lease.
 */
export const TENANT_SLOT_ACQUIRE_SCRIPT = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local ttlMs  = tonumber(ARGV[2])
local member = ARGV[3]
local maxN   = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

local active = redis.call('ZCARD', key)
if active >= maxN then
  return {0, active}
end

redis.call('ZADD', key, now + ttlMs, member)
redis.call('PEXPIRE', key, ttlMs * 2)
return {1, active + 1}
`;

/**
 * Release exactly this job's lease.
 *
 * KEYS[1] = `ai_slots:{tenantId}`
 * ARGV[1] = member
 *
 * Token-scoped by construction: a job can only ever remove the member it added, so a late release
 * from a job whose lease already expired (and whose slot was reassigned) cannot steal a live slot
 * from another job. That class of bug is unavoidable with a shared counter and impossible here.
 */
export const TENANT_SLOT_RELEASE_SCRIPT = `
redis.call('ZREM', KEYS[1], ARGV[1])
return redis.call('ZCARD', KEYS[1])
`;

/**
 * Interpret the acquire script's reply. `eval` returns a Lua table as a JS array, and ioredis
 * surfaces the numbers as numbers — but the shape is untyped, so normalise defensively.
 */
export function parseAcquireResult(raw: unknown): { acquired: boolean; active: number } {
  if (!Array.isArray(raw)) return { acquired: false, active: 0 };
  const acquired = Number(raw[0]) === 1;
  const active = Number(raw[1]);
  return { acquired, active: Number.isFinite(active) ? active : 0 };
}
