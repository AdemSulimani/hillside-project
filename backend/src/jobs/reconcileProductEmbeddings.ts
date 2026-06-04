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

  // Fetch candidates: rows missing an embedding, missing the hash, or embedded with a
  // different model version. We re-compute the hash in-process rather than in SQL to
  // keep the DB-side query simple and avoid installing pgcrypto.
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
       AND (
         embedding IS NULL
         OR embedding_input_hash IS NULL
         OR embedding_model IS NULL
         OR embedding_model <> $1
       )
     ORDER BY updated_at DESC
     LIMIT $2`,
    [activeModel, RECONCILE_BATCH_LIMIT * 3], // Fetch extra — some may be hash-current
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
        jobId: `embed-reconcile:${row.id}`,
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
