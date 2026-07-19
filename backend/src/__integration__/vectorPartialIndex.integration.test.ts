/**
 * P3-2 (RC-04) integration: per-tenant partial HNSW indexes against a REAL pgvector Postgres.
 *
 * Only a real database can verify the three properties the unit suite cannot:
 *   1. The sweep's runtime DDL actually builds a VALID partial index (CONCURRENTLY, autocommit).
 *   2. THE PLANNER USES IT — with the tenant id inlined as a literal, the plan node names the
 *      tenant's index, not the global one. This is the whole point: a partial index the planner
 *      never picks is pure write amplification.
 *   3. Recall through the inlined path: querying with a seeded row's own vector returns that row
 *      first at ~1.0 similarity, via `searchProductsBySimilarity` end-to-end.
 * Plus the drop half: a tenant falling below the hysteresis floor loses its index on the next
 * sweep.
 *
 * MIN_ROWS is pinned at 300 — above the 257-row dev tenant — so the sweep can never build an
 * index for real dev data; cleanup additionally drops only indexes that did not pre-exist.
 *
 * Run with `npm run test:integration` (needs DATABASE_URL with the pgvector extension).
 */
import 'dotenv/config';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pool from '../db/pool';
import {
  PARTIAL_INDEX_PREFIX,
  invalidateMembershipCache,
  runVectorPartialIndexSweep,
  tenantHasPartialIndex,
  tenantIndexName,
} from '../db/vectorPartialIndexes';
import { searchProductsBySimilarity } from '../db/models/product';

const ROWS = 300;

describe('per-tenant partial HNSW index (real Postgres)', () => {
  let tenantId: string;
  let fillerTenantId: string;
  let indexName: string;
  let preExisting: Set<string>;

  async function seedTenant(name: string, rows: number): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO tenants (id, name, niche) VALUES ($1, $2, $3)', [
      id,
      `${name}-${id.slice(0, 8)}`,
      'test',
    ]);
    // Server-side random 1536-dim vectors; the `WHERE g = g` correlates the aggregate subquery to
    // the outer row so every product gets a DIFFERENT vector (an uncorrelated subquery would be
    // evaluated once and break the recall assertion).
    await pool.query(
      `INSERT INTO products (tenant_id, name, is_active, embedding)
       SELECT $1, 'vpi-test-' || g, true,
              (SELECT ('[' || string_agg(random()::text, ',') || ']')
                 FROM generate_series(1, 1536) s WHERE g = g)::vector
         FROM generate_series(1, ${rows}) g`,
      [id],
    );
    return id;
  }

  before(async () => {
    process.env.VECTOR_TENANT_PARTIAL_INDEX = 'true';
    process.env.VECTOR_PARTIAL_INDEX_MIN_ROWS = String(ROWS);
    process.env.VECTOR_PARTIAL_INDEX_MAX_TENANTS = '25';

    const { rows: pre } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname LIKE $1`,
      [`${PARTIAL_INDEX_PREFIX}%`],
    );
    preExisting = new Set(pre.map((r) => r.relname));

    tenantId = await seedTenant('vpi-test', ROWS);
    indexName = tenantIndexName(tenantId);
    // The FILLER tenant is what makes the planner assertion below deterministic on ANY database.
    // Index choice is cost-based, and on a freshly-migrated DB (CI) the products table would hold
    // ONLY our tenant's rows — the global index and the partial index then cover identical row
    // sets, the costs tie, and the planner is free to pick the global one (which is exactly what
    // the first CI run did). With 5x filler rows the global index is always strictly larger than
    // the tenant's partial index, which is also the real multi-tenant shape the mechanism exists
    // for. The filler qualifies for its own index too (>= MIN_ROWS) — harmless; cleanup diffs
    // against `preExisting`.
    fillerTenantId = await seedTenant('vpi-filler', ROWS * 5);
    // Fresh stats: the bulk inserts above may precede any autoanalyze, and a cost-based assertion
    // should not depend on autovacuum timing.
    await pool.query('ANALYZE products');
  });

  after(async () => {
    delete process.env.VECTOR_TENANT_PARTIAL_INDEX;
    delete process.env.VECTOR_PARTIAL_INDEX_MIN_ROWS;
    delete process.env.VECTOR_PARTIAL_INDEX_MAX_TENANTS;
    // Drop ONLY indexes this test created, then the tenant (cascade removes the products).
    const { rows: post } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname LIKE $1`,
      [`${PARTIAL_INDEX_PREFIX}%`],
    );
    for (const r of post) {
      if (!preExisting.has(r.relname)) {
        await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${r.relname}`).catch(() => undefined);
      }
    }
    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id = $1', [fillerTenantId]).catch(() => undefined);
    await pool.end();
  });

  it('the sweep builds a VALID partial index for the large tenant', async () => {
    const result = await runVectorPartialIndexSweep();
    assert.equal(result.skipped, false);
    assert.ok(result.created >= 1, `expected a create, got ${JSON.stringify(result)}`);

    const { rows } = await pool.query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = $1`,
      [indexName],
    );
    assert.equal(rows.length, 1, `index ${indexName} must exist`);
    assert.equal(rows[0].valid, true, 'a CONCURRENTLY build that succeeded must be valid');
    assert.equal(await tenantHasPartialIndex(tenantId), true);
  });

  it('the planner uses the TENANT index when the id is inlined as a literal', async () => {
    const { rows: sample } = await pool.query<{ embedding: string }>(
      `SELECT embedding::text AS embedding FROM products WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The property under test is USABILITY, not preference: only the inlined literal makes the
      // partial HNSW index LEGAL for this query (a bound $1 never can). Which of two usable HNSW
      // indexes the planner then PREFERS belongs to pgvector's cost model and flips with stats,
      // row counts and versions — the first CI run picked the global index on a fresh DB where
      // both covered identical rows, and the model can prefer global even at 6x the rows. So the
      // choice is made deterministic: seqscan and sort off (an ordering-providing index is the
      // only way to satisfy ORDER BY <=> ... LIMIT), and the global index dropped INSIDE this
      // transaction — a catalog-only change, restored instantly by the ROLLBACK below, nothing is
      // rebuilt. What remains legal is exactly the set the literal-inlining earns: the tenant's
      // own partial index. If inlining stopped implying the index predicate, this plan would have
      // no index at all.
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_sort = off');
      await client.query('DROP INDEX idx_products_embedding');
      const { rows } = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM products
          WHERE tenant_id = '${tenantId}'
            AND deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT 5`,
        [sample[0].embedding],
      );
      // ROLLBACK, never COMMIT: it is what un-drops the global index.
      await client.query('ROLLBACK');
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      assert.ok(
        plan.includes(indexName),
        `plan must use ${indexName}; got: ${plan.slice(0, 400)}`,
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });

  it('recall through the real search path: a seeded vector finds its own row first', async () => {
    const { rows: sample } = await pool.query<{ id: string; embedding: string }>(
      `SELECT id, embedding::text AS embedding FROM products WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const vector = JSON.parse(sample[0].embedding) as number[];
    assert.equal(vector.length, 1536);

    const results = await searchProductsBySimilarity(tenantId, vector, 5);
    assert.ok(results.length > 0, 'the inlined similarity query must return rows');
    assert.equal(results[0].id, sample[0].id, 'nearest neighbour of a stored vector is itself');
    assert.ok(Number(results[0].similarity) > 0.999, `similarity ${results[0].similarity}`);
  });

  it('a tenant falling below the hysteresis floor loses its index on the next sweep', async () => {
    await pool.query('UPDATE products SET deleted_at = now() WHERE tenant_id = $1', [tenantId]);
    invalidateMembershipCache();

    const result = await runVectorPartialIndexSweep();
    assert.ok(result.dropped >= 1, `expected a drop, got ${JSON.stringify(result)}`);

    const { rows } = await pool.query(
      `SELECT 1 FROM pg_class WHERE relname = $1`,
      [indexName],
    );
    assert.equal(rows.length, 0, 'the index must be gone');
    assert.equal(await tenantHasPartialIndex(tenantId), false);
  });
});
