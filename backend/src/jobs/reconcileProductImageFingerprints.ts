import crypto from 'crypto';
import pool from '../db/pool';
import { defaultQueue } from './queues';
import { findMissingImageFingerprintCandidates } from '../db/models/productImageFingerprint';
import type { GenerateProductImageFingerprintJobData } from './generateProductImageFingerprint';

const RECONCILE_BATCH_LIMIT = (() => {
  const raw = process.env.IMAGE_FINGERPRINT_RECONCILE_BATCH_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

export const IMAGE_FINGERPRINT_RECONCILE_CRON =
  process.env.IMAGE_FINGERPRINT_RECONCILE_CRON ?? '30 */6 * * *';

/**
 * Fast lane (default every 2 minutes): catches catalog images whose fingerprint
 * job was dropped, errored, or is lagging, so image-based AI matching reflects
 * new/updated product images within minutes instead of up to 6 hours. Idempotent
 * via `jobId` dedup keyed on the image URL hash.
 */
export const FAST_IMAGE_FINGERPRINT_RECONCILE_CRON =
  process.env.FAST_IMAGE_FINGERPRINT_RECONCILE_CRON ?? '*/2 * * * *';

const FAST_RECONCILE_BATCH_LIMIT = (() => {
  const raw = process.env.FAST_IMAGE_FINGERPRINT_RECONCILE_BATCH_LIMIT;
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

export async function processReconcileProductImageFingerprints(): Promise<void> {
  const candidates = await findMissingImageFingerprintCandidates(RECONCILE_BATCH_LIMIT);

  let queued = 0;
  for (const row of candidates) {
    await defaultQueue.add(
      'product.imageFingerprint',
      {
        productId: row.product_id,
        tenantId: row.tenant_id,
        imageUrl: row.image_url,
      } satisfies GenerateProductImageFingerprintJobData,
      { priority: 5 },
    );
    queued++;
  }

  console.info('[imageFingerprintReconcile] Queued missing fingerprints', { queued });
}

export async function processFastReconcileProductImageFingerprints(): Promise<void> {
  const candidates = await findMissingImageFingerprintCandidates(FAST_RECONCILE_BATCH_LIMIT);
  if (candidates.length === 0) return;

  await Promise.all(
    candidates.map((row) => {
      const urlHash = crypto.createHash('sha256').update(row.image_url, 'utf8').digest('hex');
      return defaultQueue.add(
        'product.imageFingerprint',
        {
          productId: row.product_id,
          tenantId: row.tenant_id,
          imageUrl: row.image_url,
        } satisfies GenerateProductImageFingerprintJobData,
        {
          // Higher priority than the slow 6h reconcile (5), below live uploads (1)
          // and bulk imports (2).
          priority: 4,
          jobId: `fp-fast-${urlHash}`,
        },
      );
    }),
  );

  console.info('[imageFingerprintReconcile:fast] Re-queued missing fingerprints', {
    queued: candidates.length,
  });
}

export async function initFastImageFingerprintReconcileScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    'imageFingerprintReconcileFast',
    { pattern: FAST_IMAGE_FINGERPRINT_RECONCILE_CRON },
    {
      name: 'imageFingerprintReconcileFast',
      data: {} as GenerateProductImageFingerprintJobData,
      opts: { priority: 4, removeOnComplete: 5, removeOnFail: 20 },
    },
  );
  console.info('[jobs] Registered fast image fingerprint reconciliation scheduler', {
    cron: FAST_IMAGE_FINGERPRINT_RECONCILE_CRON,
    batchLimit: FAST_RECONCILE_BATCH_LIMIT,
  });
}

export async function initImageFingerprintReconcileScheduler(): Promise<void> {
  await defaultQueue.upsertJobScheduler(
    'imageFingerprintReconcile',
    { pattern: IMAGE_FINGERPRINT_RECONCILE_CRON },
    {
      name: 'imageFingerprintReconcile',
      data: {} as GenerateProductImageFingerprintJobData,
      opts: { priority: 5 },
    },
  );
  console.info('[jobs] Registered image fingerprint reconciliation scheduler', {
    cron: IMAGE_FINGERPRINT_RECONCILE_CRON,
    batchLimit: RECONCILE_BATCH_LIMIT,
  });
}

export async function countCatalogImagesMissingFingerprints(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM products p
     CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(p.image_urls, '[]'::jsonb)) AS img(url)
     LEFT JOIN product_image_fingerprints pif
       ON pif.tenant_id = p.tenant_id
      AND pif.image_url_hash = encode(digest(img.url, 'sha256'), 'hex')
     WHERE p.deleted_at IS NULL
       AND p.is_active = true
       AND (pif.id IS NULL OR pif.embedding IS NULL)`,
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}
