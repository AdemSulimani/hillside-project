/**
 * P2-3 (RC-17 + C-55) — versioned / compare-and-set caching for the per-tenant `ai_config` blob
 * (and its prompt-blocks twin). The legacy cache was `EX 900` with DELETE-ONLY invalidation and an
 * UNCONDITIONAL refill, so (a) a slow reader could re-SET a stale row over a concurrent DEL and
 * serve it for up to 900s (the resurrection race), and (b) the tenant AI toggle path never
 * invalidated at all (C-55) → per-worker persona / `custom_model_id` drift.
 *
 * Fix: a value-embedded monotonic version (the row's `updated_at` as epoch-MICROS — one DB clock,
 * no worker NTP skew, sub-ms collision-safe) written with a Lua SET-IF-STRICTLY-NEWER. Populate and
 * write-through both go through the same helper so a stale populate can never overwrite a newer
 * value, and every ai_config-row mutator write-throughs the fresh row for instant fleet-wide
 * propagation. Behind `AI_CONFIG_VERSIONED_CACHE`; flag-off leaves the legacy `EX 900` delete-only
 * path in `aiService.ts` byte-for-byte (this module's helpers are simply never called).
 *
 * A DISTINCT key namespace (`ai_config:v:{t}`) is used so flipping the flag never collides with the
 * legacy `ai_config:{t}` value shape; the legacy key expires on its own.
 */
import { redisConnection } from '../jobs/redisConnection';
import type { AIConfig } from '../db/models/aiConfig';

export const AI_CONFIG_VERSIONED_CACHE =
  (process.env.AI_CONFIG_VERSIONED_CACHE ?? 'false').trim().toLowerCase() === 'true';

export const AI_CONFIG_CACHE_TTL_SECONDS = 900;

export function versionedAiConfigKey(tenantId: string): string {
  return `ai_config:v:${tenantId}`;
}

export function versionedPromptBlocksKey(tenantId: string): string {
  return `tenant_prompt_blocks:v:${tenantId}`;
}

/** Monotonic version token from a row `updated_at` (epoch micros). Missing/invalid → 0. */
export function aiConfigVersion(updatedAt: Date | string | null | undefined): number {
  if (!updatedAt) return 0;
  const ms = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime();
  return Number.isFinite(ms) ? Math.round(ms * 1000) : 0;
}

/** Version token for the prompt-blocks twin: the newest `updated_at` across the tenant's blocks. */
export function promptBlocksVersion(rows: Array<{ updated_at?: Date | string | null }>): number {
  let max = 0;
  for (const r of rows) {
    const v = aiConfigVersion(r?.updated_at ?? null);
    if (v > max) max = v;
  }
  return max;
}

/**
 * Normalize an ai_config row the SAME way `loadAIConfig` returns it, so a versioned write-through
 * and a fresh populate serialize to byte-identical cached data.
 */
export function normalizeAiConfig<T extends Partial<AIConfig>>(resolved: T): T {
  return {
    ...resolved,
    restrictions: Array.isArray((resolved as AIConfig).restrictions)
      ? (resolved as AIConfig).restrictions
      : [],
    platform_restrictions: Array.isArray((resolved as AIConfig).platform_restrictions)
      ? (resolved as AIConfig).platform_restrictions
      : [],
  };
}

// Set the key to the payload ONLY when the incoming version is strictly newer than the stored one
// (or the key is absent / undecodable). Returns 1 when written, 0 when rejected as stale.
const SET_IF_NEWER_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local ok, p = pcall(cjson.decode, cur)
  if ok and p and tonumber(p.v) and tonumber(p.v) >= tonumber(ARGV[1]) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
return 1
`;

export interface VersionedPayload<T> {
  v: number;
  data: T;
}

/** Populate/write-through a versioned key; a stale (older-or-equal version) write is rejected. */
export async function cacheSetIfNewer(
  key: string,
  version: number,
  data: unknown,
  ttlSeconds: number = AI_CONFIG_CACHE_TTL_SECONDS,
): Promise<boolean> {
  const payload = JSON.stringify({ v: version, data });
  const res = await redisConnection.eval(
    SET_IF_NEWER_LUA,
    1,
    key,
    String(version),
    payload,
    String(ttlSeconds),
  );
  return res === 1;
}

/** Read a versioned key; returns the wrapped `data` on a hit, or null on miss / legacy-shape / error. */
export async function readVersionedCache<T>(key: string): Promise<T | null> {
  return (await readVersionedCacheWithVersion<T>(key))?.data ?? null;
}

/**
 * P2-4 Part 2 (RC-17): the same read, but KEEPING the version.
 *
 * `readVersionedCache` validates `v` and then discards it, so a caller cannot ask "is this entry
 * older than the config that was in force when the message arrived?". That question is the whole
 * of the receipt snapshot's RC-17 use — see `isCachedConfigStale` in services/receiptSnapshot.ts.
 */
export async function readVersionedCacheWithVersion<T>(
  key: string,
): Promise<{ data: T; v: number } | null> {
  const raw = await redisConnection.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as VersionedPayload<T>;
    if (parsed && typeof parsed.v === 'number' && 'data' in parsed) {
      return { data: parsed.data, v: parsed.v };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Write-through the fresh ai_config row into the versioned cache (used by every ai_config-row
 * mutation path: admin edit, restore, the AI toggle (C-55), fine-tune completion). No-op when the
 * flag is off. Never throws — a cache blip must not fail a config write; the DEL from
 * `invalidateTenantAiCaches` still cleared the stale entry so the next read repopulates from DB.
 */
export async function writeThroughAiConfig(
  tenantId: string,
  freshRow: AIConfig | null | undefined,
): Promise<void> {
  if (!AI_CONFIG_VERSIONED_CACHE || !freshRow) return;
  try {
    const version = aiConfigVersion(freshRow.updated_at);
    await cacheSetIfNewer(versionedAiConfigKey(tenantId), version, normalizeAiConfig(freshRow));
  } catch {
    // best-effort — the invalidation DEL already prevents a stale serve
  }
}

/** DEL both versioned keys (ai_config + prompt-blocks). Safe no-op when the flag is off. */
export async function deleteVersionedAiCaches(tenantId: string): Promise<void> {
  if (!AI_CONFIG_VERSIONED_CACHE) return;
  await redisConnection.del(versionedAiConfigKey(tenantId), versionedPromptBlocksKey(tenantId));
}
