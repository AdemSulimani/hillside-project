/**
 * P1-4 (RC-04) — Retrieval reliability: aborting embedding timeout + negative/shared query-
 * embedding cache (negative caching killable via `RETRIEVAL_NEG_CACHE_TTL_SECONDS=0`) +
 * per-process single-flight for concurrent identical queries + `semanticSkipped` metric +
 * similarity-threshold hysteresis.
 *
 * RC-04 (`docs/audit/11-root-causes.md:297`): the legacy `generateQueryEmbeddingWithTimeout`
 * raced the OpenAI embedding call against a 5 s timer with `Promise.race` — but the timer
 * only *resolved null*; the underlying request was never cancelled and kept running up to the
 * client's 60 s ceiling. `catch → null` swallowed every error, only successes were cached (in
 * a per-process 256-entry Map), so a timed-out query re-raced on every identical message
 * (self-amplifying under OpenAI slowness — Issue-2) and different workers diverged (Issue-1).
 *
 * This module is the single home for the retrieval-reliability contract. It is a pure /
 * dependency-injected helper set (mirrors `classifierConfidenceContract.ts` and
 * `productInformationGapHelpers.ts`): the orchestrator takes an injectable `deps` bag so the
 * abort/timeout, negative-cache, dimension-guard and fail-open branches are all unit-testable
 * in-process without a live OpenAI or Redis (mirrors the injected-client idiom in
 * `outboundEchoRegistry.ts` and the injected `matcher` in `productRetrieval.test.ts`).
 *
 * Scoping honesty: RC-04 is WEAKENED — with `text-embedding-3-small` the vector arm rarely
 * clears 0.65 (EV-043), so this is primarily a reliability + observability fix, not an Issue-1
 * determinism silver bullet. The 5 s deadline dominates any 429/5xx backoff, so this path is a
 * *fast fail-open to lexical retrieval*, not a 429-survival path.
 */
import { createHash } from 'crypto';
import * as Sentry from '@sentry/node';
import { knobNumber } from '../config/knobs';
import { EXPECTED_EMBEDDING_DIM as COLUMN_EMBEDDING_DIM, resolveModel } from '../config/models';
import { redisConnection } from '../jobs/redisConnection';

// NOTE: openaiClient and embeddingService are imported LAZILY (dynamic import inside the
// default `embed`) rather than statically, so this module stays import-safe for unit tests —
// openaiClient throws at load without OPENAI_API_KEY (mirrors the pattern in
// usageSuitabilityHelpers.ts / conversationProductContext.test.ts). Tests inject their own
// `embed` and `redis`, so neither dependency is loaded during the suite.
//
// `config/models` by contrast is imported STATICALLY and safely: P2-7 made it a leaf module with
// no module-load side effects precisely so this file no longer has to duplicate model defaults.

// ---------------------------------------------------------------------------
// Knobs (IIFE + clamp idiom, mirrors classifierConfidenceContract.ts:48-52).
// ---------------------------------------------------------------------------

/**
 * The embedding dimension the `products.embedding` column is declared with
 * (`migrations/029_products_embedding_1536.sql` → `vector(1536)`). The dimension guard is
 * sourced from the COLUMN contract, not the model, because its job is "does this vector fit
 * the column".
 *
 * P2-7: re-exported from `config/models` rather than re-declared — the literal `1536` previously
 * existed in three places (here, validateEnv, and the migration). `npm run config:check` verifies
 * the constant still matches what the database actually declares, so it cannot silently rot.
 */
export const EXPECTED_EMBEDDING_DIM = COLUMN_EMBEDDING_DIM;

/**
 * Timeout for OpenAI query-embedding calls (ms). When OpenAI is slow or rate-limited, the
 * semantic path is skipped and keyword/phrase search still runs — correct fail-open behaviour
 * — but only now that the hung request is actually cancelled (AbortController), not merely
 * abandoned by a `Promise.race`. Tunable without a code change.
 */
export const EMBEDDING_QUERY_TIMEOUT_MS = knobNumber('EMBEDDING_QUERY_TIMEOUT_MS');

/**
 * When true, POSITIVE query embeddings are shared across workers via Redis (keyed by
 * model+hash(text)) so the fleet converges on one vector. Default false → the legacy
 * in-process Map only (today's behaviour, byte-for-byte). The NEGATIVE (skip) cache is
 * Redis-backed regardless of this flag (tiny sentinels), which is the cross-worker RC-04 fix
 * at negligible memory. Gated because a shared positive-vector cache adds a hot-path consumer
 * to the 192 MB `noeviction` Redis (SPOF-2); flip per environment after observing footprint.
 */
export const RETRIEVAL_SHARED_CACHE =
  (process.env.RETRIEVAL_SHARED_CACHE ?? 'false').trim().toLowerCase() === 'true';

/** TTL (s) for shared positive query-embedding vectors. Short, to bound the noeviction footprint. */
export const RETRIEVAL_POS_CACHE_TTL_SECONDS = (() => {
  const raw = process.env.RETRIEVAL_POS_CACHE_TTL_SECONDS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 600;
})();

/**
 * TTL (s) for negative (skip) sentinels. A timed-out/failed query is negatively cached for
 * this window so identical queries stop re-racing a struggling OpenAI; kept short so recovery
 * is fast. Per-exact-text, so blast radius is bounded. An explicit `0` is the kill switch
 * (the P1-4 flag-based rollback): negative caching is disabled entirely — no sentinel reads,
 * no sentinel writes. Any other invalid/absent value keeps the 30 s default.
 */
export const RETRIEVAL_NEG_CACHE_TTL_SECONDS = (() => {
  const raw = process.env.RETRIEVAL_NEG_CACHE_TTL_SECONDS;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

/**
 * Half-open hysteresis band `[threshold - band, threshold)` around SIMILARITY_THRESHOLD.
 * Candidates in the band are admitted as a SEPARATE low-weight `semantic_band` RRF source
 * (never at the full 2.0 semantic weight) so a weak boundary vector only ranks with
 * corroboration. `0` (default) ⇒ the band is always empty ⇒ retrieved sets identical to
 * today. Clamped to `[0, 0.15]`: EV-043 shows same-category noise scores 0.54–0.59, so a band
 * wide enough to capture it would re-admit that noise — keep this a blunt, default-off knob;
 * the real fix is the model/threshold spike (out of scope).
 */
export const SIMILARITY_HYSTERESIS_BAND = (() => {
  const raw = process.env.SIMILARITY_HYSTERESIS_BAND;
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 0.15 ? n : 0;
})();

/** RRF weight of the hysteresis-band source (core semantic stays 2.0). */
export const SEMANTIC_BAND_WEIGHT = (() => {
  const raw = process.env.SEMANTIC_BAND_WEIGHT;
  const n = raw ? parseFloat(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1.0;
})();

/**
 * Extra rows to fetch from the similarity search when the band is active, so band candidates
 * (which score below `limit`'s top-N core matches) are not starved by the SQL `LIMIT`. Only
 * applied when `SIMILARITY_HYSTERESIS_BAND > 0`.
 */
export const SEMANTIC_BAND_EXTRA_DEPTH = (() => {
  const raw = process.env.SEMANTIC_BAND_EXTRA_DEPTH;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 5;
})();

/**
 * Active embedding model.
 *
 * P2-7 (M8): this used to duplicate `'text-embedding-3-large'` as a literal rather than import it,
 * because importing `openaiClient` triggers a module-load throw + client construction and would
 * break this module's import-safety. `config/models.ts` is the side-effect-free home that removed
 * the need for the copy — one chain, one place, imported by both.
 */
export function activeEmbeddingModel(): string {
  return resolveModel('embedding');
}

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

/** SHA-256 of the query text — keeps raw customer text (PII) out of Redis keys / SCAN output. */
function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Positive-cache Redis key. Content-addressed by model+hash(text) and intentionally NOT
 * tenant-scoped: a query embedding is a pure function of (model, text), so sharing it across
 * tenants is a dedup win, not a leak — the tenant filter stays downstream in
 * `searchProductsBySimilarity` (`WHERE tenant_id = $1`). Including the model prevents ever
 * serving a vector produced by a DIFFERENT model (meaningless cosine distances).
 */
export function queryEmbeddingRedisKey(model: string, text: string): string {
  return `qemb:${model}:${hashText(text)}`;
}

/** Negative-cache (skip sentinel) Redis key — same model+hash addressing as the positive key. */
export function negativeCacheKey(model: string, text: string): string {
  return `qemb:neg:${model}:${hashText(text)}`;
}

/** True iff the vector matches the `products.embedding` column dimension (the DB contract). */
export function isExpectedDimension(vec: number[]): boolean {
  return vec.length === EXPECTED_EMBEDDING_DIM;
}

/**
 * Encode a vector as base64 Float32 (~8 KB for 1536 dims vs ~30 KB as a JSON double array).
 * Float32 keeps ~7 significant digits — lossless enough for cosine similarity and far below
 * the embedding model's own run-to-run variance.
 */
export function encodeVector(vec: number[]): string {
  const f32 = Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
}

/** Decode a base64 Float32 blob produced by {@link encodeVector}. Copies into a fresh, 4-byte
 * aligned buffer so the `Float32Array` view is always valid regardless of the pooled Buffer's
 * byteOffset. */
export function decodeVector(encoded: string): number[] {
  const buf = Buffer.from(encoded, 'base64');
  const usable = buf.byteLength - (buf.byteLength % 4);
  const aligned = new Uint8Array(usable);
  aligned.set(buf.subarray(0, usable));
  return Array.from(new Float32Array(aligned.buffer, 0, usable / 4));
}

/**
 * Partition similarity candidates into `core` (`>= threshold`) and a hysteresis `band`
 * (`[threshold - band, threshold)`). With `band === 0` the band is always empty, so callers
 * that fuse only `core` reproduce the legacy `filter(similarity >= threshold)` byte-for-byte.
 */
export function partitionBySimilarityBand<T extends { similarity: number }>(
  items: T[],
  threshold: number,
  band: number,
): { core: T[]; band: T[] } {
  const core: T[] = [];
  const bandItems: T[] = [];
  for (const item of items) {
    if (item.similarity >= threshold) core.push(item);
    else if (band > 0 && item.similarity >= threshold - band) bandItems.push(item);
  }
  return { core, band: bandItems };
}

// ---------------------------------------------------------------------------
// In-process positive cache (model-scoped LRU Map — the legacy behaviour).
// ---------------------------------------------------------------------------

const QUERY_EMBEDDING_CACHE_MAX = 256;

export interface InProcessEmbeddingCache {
  get(model: string, text: string): number[] | undefined;
  set(model: string, text: string, vector: number[]): void;
}

/** Model-scoped LRU (Map insertion-order eviction), capped at {@link QUERY_EMBEDDING_CACHE_MAX}. */
export function createInProcessEmbeddingCache(max = QUERY_EMBEDDING_CACHE_MAX): InProcessEmbeddingCache {
  const cache = new Map<string, number[]>();
  const keyOf = (model: string, text: string) => `${model}\0${text}`;
  return {
    get(model, text) {
      return cache.get(keyOf(model, text));
    },
    set(model, text, vector) {
      if (cache.size >= max) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(keyOf(model, text), vector);
    },
  };
}

const defaultInProcessCache = createInProcessEmbeddingCache();

// ---------------------------------------------------------------------------
// Observability — `semanticSkipped` metric + loud dimension-mismatch marker.
// "Log-now, ledger-later": grep the markers to measure the real skip/dim-mismatch rate; when
// P1-5's decision ledger lands these become per-reply ledger fields.
// ---------------------------------------------------------------------------

export type SemanticSkipReason =
  | 'embedding_timeout'
  | 'embedding_error'
  | 'dim_mismatch'
  | 'similarity_query_error';

/** Minimal Redis surface used by the reliability path (satisfied by the ioredis singleton). */
export interface RetrievalRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  incr(key: string): Promise<number>;
}

/**
 * Emit a grep-able `[SEMANTIC_SKIPPED]` marker and a fail-open Redis counter whenever the
 * semantic arm is dropped. The counter is best-effort — a Redis blip on the metric must never
 * fail the reply. The per-request skip rate is still visible on the existing `[retrieval]`
 * structured log; this counter is the cheap always-available rollup by reason.
 */
export function logSemanticSkipped(
  reason: SemanticSkipReason,
  tenantId: string | undefined,
  redis: RetrievalRedisClient | null = redisConnection,
): void {
  console.warn(`[SEMANTIC_SKIPPED] reason: ${reason} tenantId: ${tenantId ?? 'unknown'}`);
  if (!redis) return;
  try {
    void redis.incr(`metrics:semantic_skipped:${reason}`).catch(() => undefined);
  } catch {
    /* fail-open: never let a metric write fail the reply */
  }
}

/**
 * Distinct, LOUD marker for a dimension mismatch — a CONFIG bug (wrong/unset
 * `OPENAI_EMBEDDING_MODEL`), not a transient blip. Kept separate from the routine skip counter
 * so a fleet-wide "-large produces 3072 dims" outage is not buried under transient timeouts.
 */
export function logEmbeddingDimMismatch(
  actualDim: number,
  model: string,
  tenantId: string | undefined,
): void {
  console.error(
    `[EMBEDDING_DIM_MISMATCH] model: ${model} expected: ${EXPECTED_EMBEDDING_DIM} actual: ${actualDim} tenantId: ${tenantId ?? 'unknown'}`,
  );
  try {
    Sentry.captureMessage('embedding dimension mismatch', {
      level: 'error',
      tags: { component: 'retrieval' },
      extra: { model, expected: EXPECTED_EMBEDDING_DIM, actual: actualDim, tenantId },
    });
  } catch {
    /* Sentry is best-effort */
  }
}

// ---------------------------------------------------------------------------
// Orchestrator — aborting timeout + shared/negative cache + dimension guard.
// ---------------------------------------------------------------------------

export type EmbedFn = (text: string, opts: { signal: AbortSignal }) => Promise<number[]>;

export interface QueryEmbeddingDeps {
  /** Tenant scope, for skip logging only (the cache itself is tenant-independent). */
  tenantId?: string;
  /** Embedding function (must honour the AbortSignal). Defaults to the OpenAI-backed one. */
  embed?: EmbedFn;
  /** Redis client (or null to run in-process only, e.g. in tests). Defaults to the singleton. */
  redis?: RetrievalRedisClient | null;
  /** Active embedding model — part of the cache key. Defaults to {@link activeEmbeddingModel}. */
  model?: string;
  /** Abort deadline (ms). Defaults to {@link EMBEDDING_QUERY_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Share positive vectors via Redis. Defaults to {@link RETRIEVAL_SHARED_CACHE}. */
  sharedCache?: boolean;
  posCacheTtl?: number;
  negCacheTtl?: number;
  inProcess?: InProcessEmbeddingCache;
}

export type QueryEmbeddingSource =
  | 'inprocess'
  | 'shared'
  | 'computed'
  | 'negative_cache'
  | 'skip';

export interface QueryEmbeddingResult {
  vector: number[] | null;
  source: QueryEmbeddingSource;
  reason?: SemanticSkipReason;
}

async function readNegative(
  redis: RetrievalRedisClient | null,
  model: string,
  text: string,
  ttl: number,
): Promise<boolean> {
  if (ttl <= 0 || !redis) return false; // ttl 0 = kill switch: negative caching disabled
  try {
    return Boolean(await redis.get(negativeCacheKey(model, text)));
  } catch {
    return false; // fail-open: a Redis error must not force a skip
  }
}

async function writeNegative(
  redis: RetrievalRedisClient | null,
  model: string,
  text: string,
  ttl: number,
): Promise<void> {
  if (ttl <= 0 || !redis) return; // ttl 0 = kill switch: never write a skip sentinel
  try {
    await redis.set(negativeCacheKey(model, text), '1', 'EX', ttl);
  } catch {
    /* fail-open */
  }
}

async function readSharedPositive(
  redis: RetrievalRedisClient | null,
  model: string,
  text: string,
): Promise<number[] | null> {
  if (!redis) return null;
  try {
    const raw = await redis.get(queryEmbeddingRedisKey(model, text));
    if (!raw) return null;
    const vec = decodeVector(raw);
    return isExpectedDimension(vec) ? vec : null; // ignore a stale wrong-dimension entry
  } catch {
    return null; // fail-open → recompute
  }
}

async function writeSharedPositive(
  redis: RetrievalRedisClient | null,
  model: string,
  text: string,
  vector: number[],
  ttl: number,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(queryEmbeddingRedisKey(model, text), encodeVector(vector), 'EX', ttl);
  } catch {
    /* fail-open */
  }
}

/**
 * Per-process single-flight map: in-flight resolves keyed by model+text (same keying as the
 * in-process cache). Without it, N concurrent identical queries that miss every cache each
 * call OpenAI — the positive caches are only written AFTER a compute completes. Sharing the
 * WHOLE resolve (including the negative-cache read/write) is safe because the result is a pure
 * function of (model, text); `tenantId` is only used for skip logging. Entries are removed in
 * a `finally` — success AND failure — so a failed computation never poisons later calls.
 */
const inFlightResolves = new Map<string, Promise<QueryEmbeddingResult>>();

/**
 * Resolve a query embedding with a HARD abort deadline, a shared/in-process positive cache,
 * and a negative (skip) cache. Returns a structured result (`vector` + `source`/`reason`) so
 * the timeout/dimension/fail-open branches are directly assertable in tests; the thin
 * {@link getOrComputeQueryEmbedding} wrapper narrows it to `number[] | null` for callers.
 *
 * Concurrent callers with the same model+text share ONE in-flight computation (single-flight);
 * otherwise order per call: in-process positive → shared positive → negative (skip) → compute
 * (aborting) → dimension guard → cache. Positive is checked BEFORE negative and returns early,
 * so a live good vector is never shadowed by a stale skip sentinel.
 */
export async function resolveQueryEmbedding(
  text: string,
  deps: QueryEmbeddingDeps = {},
): Promise<QueryEmbeddingResult> {
  const model = deps.model ?? activeEmbeddingModel();
  const key = `${model} ${text}`;
  const existing = inFlightResolves.get(key);
  if (existing) return existing;
  // NOTE: the map is populated synchronously (no await before `set`), so two callers in the
  // same tick already coalesce; the `finally` removes the entry once settled either way.
  const flight = resolveQueryEmbeddingUncoalesced(text, deps).finally(() => {
    inFlightResolves.delete(key);
  });
  inFlightResolves.set(key, flight);
  return flight;
}

async function resolveQueryEmbeddingUncoalesced(
  text: string,
  deps: QueryEmbeddingDeps,
): Promise<QueryEmbeddingResult> {
  const embed: EmbedFn =
    deps.embed ??
    (async (t, opts) => {
      // Lazy import keeps this module import-safe for unit tests; production callers hit this
      // path, tests inject their own `embed`.
      const { generateEmbedding } = await import('./embeddingService');
      return generateEmbedding(t, opts);
    });
  const redis = deps.redis === undefined ? redisConnection : deps.redis;
  const model = deps.model ?? activeEmbeddingModel();
  const timeoutMs = deps.timeoutMs ?? EMBEDDING_QUERY_TIMEOUT_MS;
  const sharedCache = deps.sharedCache ?? RETRIEVAL_SHARED_CACHE;
  const posCacheTtl = deps.posCacheTtl ?? RETRIEVAL_POS_CACHE_TTL_SECONDS;
  const negCacheTtl = deps.negCacheTtl ?? RETRIEVAL_NEG_CACHE_TTL_SECONDS;
  const inProcess = deps.inProcess ?? defaultInProcessCache;
  const tenantId = deps.tenantId;

  // 1. In-process positive cache (always consulted; cheapest).
  const local = inProcess.get(model, text);
  if (local) return { vector: local, source: 'inprocess' };

  // 2. Shared positive cache (Redis) — only when enabled.
  if (sharedCache) {
    const shared = await readSharedPositive(redis, model, text);
    if (shared) {
      inProcess.set(model, text, shared);
      return { vector: shared, source: 'shared' };
    }
  }

  // 3. Negative (skip) cache — a recent timeout/failure suppresses the re-race.
  //    A TTL of 0 disables this branch entirely (kill switch).
  if (await readNegative(redis, model, text, negCacheTtl)) {
    return { vector: null, source: 'negative_cache' };
  }

  // 4. Compute with a HARD abort deadline (actually cancels the request).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let vector: number[];
  try {
    vector = await embed(text, { signal: controller.signal });
  } catch {
    const reason: SemanticSkipReason = controller.signal.aborted
      ? 'embedding_timeout'
      : 'embedding_error';
    logSemanticSkipped(reason, tenantId, redis);
    await writeNegative(redis, model, text, negCacheTtl);
    return { vector: null, source: 'skip', reason };
  } finally {
    clearTimeout(timer);
  }

  // 5. Dimension guard (the -large 3072 landmine). Negative-cache once so we don't recompute a
  //    permanently-bad vector every request; emit the loud, distinct config-outage marker.
  if (!isExpectedDimension(vector)) {
    logEmbeddingDimMismatch(vector.length, model, tenantId);
    logSemanticSkipped('dim_mismatch', tenantId, redis);
    await writeNegative(redis, model, text, negCacheTtl);
    return { vector: null, source: 'skip', reason: 'dim_mismatch' };
  }

  // 6. Cache + return.
  if (sharedCache) await writeSharedPositive(redis, model, text, vector, posCacheTtl);
  inProcess.set(model, text, vector);
  return { vector, source: 'computed' };
}

/** Thin wrapper: the aborting/cached query embedding, or `null` when the semantic arm is skipped. */
export async function getOrComputeQueryEmbedding(
  text: string,
  deps: QueryEmbeddingDeps = {},
): Promise<number[] | null> {
  return (await resolveQueryEmbedding(text, deps)).vector;
}
