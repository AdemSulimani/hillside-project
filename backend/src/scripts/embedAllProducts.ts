import 'dotenv/config';
import pool from '../db/pool';
import { embeddingQueue } from '../jobs/queues';

/**
 * One-time backfill script: dispatches a GenerateProductEmbedding job
 * for every product that doesn't yet have an embedding vector.
 *
 * Usage:  npx tsx src/scripts/embedAllProducts.ts
 */
async function main() {
  const { rows } = await pool.query<{ id: string; tenant_id: string; name: string }>(
    `SELECT id, tenant_id, name FROM products
     WHERE embedding IS NULL AND deleted_at IS NULL
     ORDER BY created_at ASC`,
  );

  if (rows.length === 0) {
    console.log('[embedAllProducts] All products already have embeddings.');
    await pool.end();
    return;
  }

  console.log(`[embedAllProducts] Dispatching embedding jobs for ${rows.length} product(s)…`);

  for (const product of rows) {
    await embeddingQueue.add('product.embedding', {
      productId: product.id,
      tenantId: product.tenant_id,
    });
    console.log(`  → queued: ${product.name} (${product.id})`);
  }

  console.log('[embedAllProducts] All jobs dispatched. Workers will process them in the background.');
  await pool.end();
}

main().catch((err) => {
  console.error('[embedAllProducts] Failed:', err);
  process.exit(1);
});
