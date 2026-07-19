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
  let indexName: string;
  let preExisting: Set<string>;

  before(async () => {
    process.env.VECTOR_TENANT_PARTIAL_INDEX = 'true';
    process.env.VECTOR_PARTIAL_INDEX_MIN_ROWS = String(ROWS);
    process.env.VECTOR_PARTIAL_INDEX_MAX_TENANTS = '25';

    const { rows: pre } = await pool.query<{ relname: string }>(
      `SELECT relname FROM pg_class WHERE relname LIKE $1`,
      [`${PARTIAL_INDEX_PREFIX}%`],
    );
    preExisting = new Set(pre.map((r) => r.relname));

    tenantId = crypto.randomUUID();
    indexName = tenantIndexName(tenantId);
    await pool.query('INSERT INTO tenants (id, name, niche) VALUES ($1, $2, $3)', [
      tenantId,
      `vpi-test-${tenantId.slice(0, 8)}`,
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
         FROM generate_series(1, ${ROWS}) g`,
      [tenantId],
    );
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
      // At 300 rows the planner happily fetches everything via the tenant btree and sorts — cheap
      // and correct, but not the property under test. The property is USABILITY: only the inlined
      // literal makes the partial HNSW index legal for this query. Disabling seqscan AND sort
      // leaves an ordering-providing index as the only way to satisfy ORDER BY <=> ... LIMIT, so
      // the plan must name an HNSW index — and the assertion below demands it is the TENANT's.
      await client.query('SET LOCAL enable_seqscan = off');
      await client.query('SET LOCAL enable_sort = off');
      const { rows } = await client.query(
        `EXPLAIN (FORMAT JSON)
         SELECT id FROM products
          WHERE tenant_id = '${tenantId}'
            AND deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL
          ORDER BY embedding <=> $1::vector
          LIMIT 5`,
        [sample[0].embedding],
      );
      await client.query('COMMIT');
      const plan = JSON.stringify(rows[0]['QUERY PLAN']);
      assert.ok(
        plan.includes(indexName),
        `plan must use ${indexName}; got: ${plan.slice(0, 400)}`,
      );
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
