/**
 * Direct (no-queue) embedding backfill for products with `embedding IS NULL`.
 *
 * `embed-all` dispatches BullMQ jobs, which is right for production (workers absorb the
 * rate) — but in a dev environment with no running worker the jobs just sit in Redis and
 * retrieval stays dead (a NULL embedding excludes the row from every semantic search).
 * This script runs the SAME processor the worker would run (`processGenerateProductEmbedding`),
 * inline and sequentially, so a backfill's nulled embeddings can be restored immediately.
 *
 * Usage:
 *   npx tsx src/scripts/embedPendingDirect.ts              # all tenants
 *   npx tsx src/scripts/embedPendingDirect.ts --tenant <uuid>
 */
import 'dotenv/config';
import pool from '../db/pool';
import { processGenerateProductEmbedding } from '../jobs/generateProductEmbedding';

async function main(): Promise<void> {
  const tenantArgIdx = process.argv.indexOf('--tenant');
  const tenant = tenantArgIdx >= 0 ? process.argv[tenantArgIdx + 1] : null;

  const params: unknown[] = [];
  let where = 'embedding IS NULL AND deleted_at IS NULL';
  if (tenant) {
    params.push(tenant);
    where += ` AND tenant_id = $${params.length}`;
  }
  const { rows } = await pool.query<{ id: string; tenant_id: string; name: string }>(
    `SELECT id, tenant_id, name FROM products WHERE ${where} ORDER BY created_at ASC`,
    params,
  );

  if (rows.length === 0) {
    console.log('[embedPendingDirect] Nothing to embed.');
    return;
  }
  console.log(`[embedPendingDirect] Embedding ${rows.length} product(s) inline…`);

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await processGenerateProductEmbedding({ productId: row.id, tenantId: row.tenant_id });
      ok += 1;
    } catch (err) {
      failed += 1;
      console.warn(`[embedPendingDirect] failed: ${row.name} (${row.id})`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[embedPendingDirect] done: ${ok} embedded, ${failed} failed.`);
}

main()
  .catch((err) => {
    console.error('[embedPendingDirect] failed', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
