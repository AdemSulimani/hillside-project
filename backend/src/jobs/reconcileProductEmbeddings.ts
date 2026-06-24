/**
 * Embedding reconciliation job — runs on a configurable cron (default: every 6 hours)
 * and automatically repairs products whose embeddings are missing or stale.
 *
 * "Stale" means the SHA-256 hash of the current buildProductText() output differs from
 * the stored embedding_input_hash, which happens when fields that feed the embedding
 * (name, brand, description, tags, category, usage_description) were updated after the
 * last embed — including the case that previously caused silent drift when
 * usage_description was edited.
 *
 * The job also catches the bulk-import lag case: when a large catalog is onboarded,
 * the embedding queue drains at concurrency 1, so semantic search silently misses new
 * products for hours. The reconciliation loop re-queues any row that still has
 * embedding IS NULL, providing a self-healing safety net even if the original job was
 * dropped or exhausted its retries.
 */
import crypto from 'crypto';
import pool from '../db/pool';
import { defaultQueue } from './queues';
import { buildProductText } from '../services/embeddingService';
import { OPENAI_EMBEDDING_MODEL } from '../services/openaiClient';
import type { GenerateProductEmbeddingJobData } from './generateProductEmbedding';

/** Max products re-queued per reconciliation run to avoid thundering herd. */
const RECONCILE_BATCH_LIMIT = (() => {
  const raw = process.env.EMBEDDING_RECONCILE_BATCH_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 200;
})();

/** Cron schedule for the reconciliation run (default every 6 hours). */
export const EMBEDDING_RECONCILE_CRON =
  process.env.EMBEDDING_RECONCILE_CRON ?? '0 */6 * * *';

/**
 * Cron schedule for the FAST reconciliation lane (default every minute).
 *
 * The 6-hour full reconcile catches *stale* embeddings (hash drift, model
 * changes), but a freshly created or edited product whose live `product.embedding`
 * job was dropped, errored, or fell behind would otherwise stay invisible to
 * semantic search for up to 6 hours. The fast lane targets only rows where
 * `embedding IS NULL` — a cheap, partial-index-backed query — so new catalog
 * data becomes retrievable within ~1 minute even when the primary job failed.
 */
export const FAST_EMBEDDING_RECONCILE_CRON =
  process.env.FAST_EMBEDDING_RECONCILE_CRON ?? '* * * * *';

/** Max NULL-embedding rows re-queued per fast reconcile run (across all tenants). */
const FAST_RECONCILE_BATCH_LIMIT = (() => {
  const raw = process.env.FAST_EMBEDDING_RECONCILE_BATCH_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 300;
})();

interface ReconcileCandidateRow {
  id: string;
  tenant_id: string;
  name: string;
  brand: string | null;
  description: string | null;
  usage_description: string | null;
  tags: string[] | null;
  category: string | null;
  flavor: string | null;
  size: string | null;
  color: string | null;
  variant: string | null;
  weight: string | null;
  embedding_input_hash: string | null;
  embedding_model: string | null;
  embedding_is_null: boolean;
}

function computeHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export async function processReconcileProductEmbeddings(): Promise<void> {
  const activeModel = process.env.OPENAI_EMBEDDING_MODEL?.trim() || OPENAI_EMBEDDING_MODEL;

  // Fetch candidates and re-compute the embedding-input hash in-process (rather than in
  // SQL, to keep the query simple and avoid pgcrypto).
  //
  // IMPORTANT: we intentionally do NOT pre-filter on embedding state here. A row whose
  // embedding fields were edited AFTER its last embed but whose live embedding job then
  // failed/was-dropped keeps a NON-NULL embedding, a NON-NULL (but STALE) hash, and a
  // matching model — so an `embedding IS NULL OR embedding_input_hash IS NULL OR
  // embedding_model <> $1` filter would never surface it, and the stale vector would
  // persist indefinitely. Scanning recently-updated active rows and comparing the stored
  // hash to the freshly-computed one is the only way to catch that drift. Rows that are
  // missing/model-mismatched are still caught because they also fail the in-process check
  // below. Ordered by updated_at DESC and capped so the scan stays bounded; genuinely
  // NULL-embedding rows older than this window are healed by the fast reconcile lane.
  const { rows } = await pool.query<ReconcileCandidateRow>(
    `SELECT
       id,
       tenant_id,
       name,
       brand,
       description,
       usage_description,
       tags,
       category,
       flavor,
       size,
       color,
       variant,
       weight,
       embedding_input_hash,
       embedding_model,
       (embedding IS NULL) AS embedding_is_null
     FROM products
     WHERE deleted_at IS NULL
       AND is_active = true
     ORDER BY updated_at DESC
     LIMIT $1`,
    [RECONCILE_BATCH_LIMIT * 3], // Fetch extra — most will be hash-current and skipped
  );

  let queued = 0;
  let skipped = 0;

  for (const row of rows) {
    if (queued >= RECONCILE_BATCH_LIMIT) break;

    const tags = Array.isArray(row.tags) ? row.tags : [];
    const text = buildProductText(
      row.name,
      row.description,
      tags,
      row.brand,
      row.category,
      row.usage_description,
      {
        flavor: row.flavor,
        size: row.size,
        color: row.color,
        variant: row.variant,
        weight: row.weight,
      },
    );
    const currentHash = computeHash(text);

    // Skip if hash and model both match — the embedding is already current.
    if (
      !row.embedding_is_null &&
      row.embedding_input_hash === currentHash &&
      row.embedding_model === activeModel
    ) {
      skipped++;
      continue;
    }

    await defaultQueue.add(
      'product.embedding',
      { productId: row.id, tenantId: row.tenant_id } satisfies GenerateProductEmbeddingJobData,
      {
        // Lower priority than live product edits (priority 5 vs default 0).
        // BullMQ: lower number = higher priority.
        priority: 5,
        jobId: `embed-reconcile-${row.id}`,
        // De-duplicate: if a job for this product is already pending, don't add another.
        // jobId dedup is handled by BullMQ — it silently drops the add if the id exists.
      },
    );
    queued++;
  }

  console.info('[reconcile] Embedding reconciliation complete', {
    candidatesScanned: rows.length,
    queued,
    skipped,
    model: activeModel,
  });
}

/**
 * Fast reconcile lane: re-queues only active products whose embedding is still
 * NULL (newly created/edited rows whose live job was dropped, errored, or is
 * lagging). Cheap and idempotent — `jobId` dedup means a product already pending
 * in the queue is never double-queued, so running this every minute is safe.
 *
 * This is the primary mechanism that keeps catalog changes automatically
 * propagating to AI retrieval without manual "Backfill embeddings" clicks.
 */
export async function processFastReconcileMissingEmbeddings(): Promise<void> {
  const { rows } = await pool.query<{ id: string; tenant_id: string }>(
    `SELECT id, tenant_id
       FROM products
      WHERE deleted_at IS NULL
        AND is_active = true
        AND embedding IS NULL
      ORDER BY updated_at DESC
      LIMIT $1`,
    [FAST_RECONCILE_BATCH_LIMIT],
  );

  if (rows.length === 0) return;

  await Promise.all(
    rows.map((row) =>
      defaultQueue.add(
        'product.embedding',
        { productId: row.id, tenantId: row.tenant_id } satisfies GenerateProductEmbeddingJobData,
        {
          // Higher priority than the slow 6h reconcile (5) but below live edits (1)
          // and bulk imports (2). BullMQ: lower number = higher priority.
          priority: 4,
          jobId: `embed-fast-${row.id}`,
        },
      ),
    ),
  );

  console.info('[reconcile:fast] Re-queued missing product embeddings', {
    queued: rows.length,
    batchLimit: FAST_RECONCILE_BATCH_LIMIT,
  });
}

/**
 * On-demand self-heal for a single tenant. Called from the AI retrieval path when
 * a non-empty customer query matched zero products but the tenant has active
 * products with missing embeddings — so the *next* message in the conversation
 * can be answered correctly without waiting for the periodic reconcile or any
 * manual admin action. Idempotent via `jobId` dedup.
 */
export async function enqueueMissingEmbeddingsForTenant(
  tenantId: string,
  limit = 200,
): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id
       FROM products
      WHERE tenant_id = $1
        AND deleted_at IS NULL
        AND is_active = true
        AND embedding IS NULL
      ORDER BY updated_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );

  if (rows.length === 0) return 0;

  await Promise.all(
    rows.map((row) =>
      defaultQueue.add(
        'product.embedding',
        { productId: row.id, tenantId } satisfies GenerateProductEmbeddingJobData,
        {
          // Customer is waiting on the answer — treat as a live edit (priority 1).
          priority: 1,
          jobId: `embed-fast-${row.id}`,
        },
      ),
    ),
  );

  return rows.length;
}

export async function initEmbeddingReconcileScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    'embeddingReconcile',
    { pattern: EMBEDDING_RECONCILE_CRON },
    {
      name: 'embeddingReconcile',
      data: {} as GenerateProductEmbeddingJobData,
      opts: {
        removeOnComplete: 10,
        removeOnFail: 50,
      },
    },
  );

  console.info('[jobs] Embedding reconciliation scheduler registered', {
    cron: EMBEDDING_RECONCILE_CRON,
  });
}

export async function initFastEmbeddingReconcileScheduler(): Promise<void> {
  // Remove stale scheduler registered under the old name in a previous deployment.
  await defaultQueue.removeJobScheduler('offerEmbeddingReconcileFast').catch(() => {});

  await defaultQueue.upsertJobScheduler(
    'embeddingReconcileFast',
    { pattern: FAST_EMBEDDING_RECONCILE_CRON },
    {
      name: 'embeddingReconcileFast',
      data: {} as GenerateProductEmbeddingJobData,
      opts: {
        removeOnComplete: 5,
        removeOnFail: 20,
      },
    },
  );

  console.info('[jobs] Fast embedding reconciliation scheduler registered', {
    cron: FAST_EMBEDDING_RECONCILE_CRON,
  });
}
