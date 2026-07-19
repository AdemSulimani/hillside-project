/**
 * P3-2 (RC-04) — per-tenant partial HNSW indexes: the pure halves.
 *
 * The properties that make the mechanism safe:
 *   - the inlined literal is UUID-validated (the validation IS the injection barrier);
 *   - the index predicate is implied by the runtime similarity query (else every index is dead
 *     weight and the sweep is pure write amplification) — pinned as a source invariant;
 *   - the reconcile plan has hysteresis (no CREATE/DROP churn at the threshold), caps write
 *     amplification, clears INVALID corpses, and drops indexes of deleted tenants.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  PARTIAL_INDEX_PREFIX,
  isUuid,
  planPartialIndexChanges,
  quoteUuidLiteral,
  tenantIndexName,
  tenantIndexPredicate,
} from '../../db/vectorPartialIndexes';

const T1 = '02beb134-1111-4a63-9d18-000000000001';
const T2 = 'aaaabbbb-2222-4a63-9d18-000000000002';
const T3 = 'ccccdddd-3333-4a63-9d18-000000000003';

describe('uuid validation + literal quoting', () => {
  it('accepts UUIDs, rejects everything else', () => {
    assert.equal(isUuid(T1), true);
    assert.equal(isUuid(T1.toUpperCase()), true);
    for (const bad of ['', 'x', "1'; DROP TABLE products; --", `${T1} `, T1.replace('-', '')]) {
      assert.equal(isUuid(bad), false, JSON.stringify(bad));
    }
  });

  it('quoteUuidLiteral lowercases and single-quotes; throws on non-UUIDs', () => {
    assert.equal(quoteUuidLiteral(T1.toUpperCase()), `'${T1}'`);
    assert.throws(() => quoteUuidLiteral("1' OR '1'='1"));
  });
});

describe('tenantIndexName', () => {
  it('is deterministic, prefixed, under the 63-char identifier limit, and tenant-distinct', () => {
    const n1 = tenantIndexName(T1);
    assert.equal(n1, tenantIndexName(T1.toUpperCase()));
    assert.ok(n1.startsWith(PARTIAL_INDEX_PREFIX));
    assert.ok(n1.length <= 63, `${n1.length} chars`);
    assert.match(n1.slice(PARTIAL_INDEX_PREFIX.length), /^[0-9a-f]{16}$/);
    assert.notEqual(n1, tenantIndexName(T2));
  });
});

describe('planPartialIndexChanges', () => {
  const base = { allTenantIds: [T1, T2, T3], minRows: 1000, maxTenants: 25 };

  it('creates for tenants at/above the threshold, skips those below', () => {
    const plan = planPartialIndexChanges({
      ...base,
      rowsByTenant: new Map([
        [T1, 5000],
        [T2, 999],
      ]),
      existing: [],
    });
    assert.deepEqual(plan.create, [T1]);
    assert.deepEqual(plan.drop, []);
  });

  it('HYSTERESIS: an existing index survives between minRows/2 and minRows', () => {
    const plan = planPartialIndexChanges({
      ...base,
      rowsByTenant: new Map([[T1, 700]]), // below 1000, above 500
      existing: [{ name: tenantIndexName(T1), valid: true }],
    });
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.drop, [], 'a tenant hovering at the threshold must not churn DDL');
  });

  it('drops below the floor, for deleted tenants, and for INVALID corpses (with re-create)', () => {
    const plan = planPartialIndexChanges({
      ...base,
      rowsByTenant: new Map([
        [T1, 400], // below floor 500 → drop
        [T2, 5000], // eligible but its index is INVALID → drop + re-create
      ]),
      existing: [
        { name: tenantIndexName(T1), valid: true },
        { name: tenantIndexName(T2), valid: false },
        { name: `${PARTIAL_INDEX_PREFIX}deadbeefdeadbeef`, valid: true }, // no such tenant
      ],
    });
    assert.deepEqual(new Set(plan.drop), new Set([
      tenantIndexName(T1),
      tenantIndexName(T2),
      `${PARTIAL_INDEX_PREFIX}deadbeefdeadbeef`,
    ]));
    assert.deepEqual(plan.create, [T2], 'an invalid corpse must be rebuilt, not skipped forever');
  });

  it('caps at maxTenants, largest catalogs first', () => {
    const plan = planPartialIndexChanges({
      ...base,
      maxTenants: 2,
      rowsByTenant: new Map([
        [T1, 2000],
        [T2, 9000],
        [T3, 5000],
      ]),
      existing: [],
    });
    assert.deepEqual(plan.create, [T2, T3]);
  });

  it('ignores non-UUID tenant ids everywhere (nothing to inline, nothing to name)', () => {
    const plan = planPartialIndexChanges({
      rowsByTenant: new Map([['not-a-uuid', 99999]]),
      allTenantIds: ['not-a-uuid'],
      existing: [],
      minRows: 1000,
      maxTenants: 25,
    });
    assert.deepEqual(plan, { create: [], drop: [] });
  });
});

describe('index predicate ↔ runtime query (source invariant)', () => {
  it('every predicate conjunct appears verbatim in searchProductsBySimilarity', () => {
    // The planner uses a partial index only when the query predicate IMPLIES the index predicate.
    // The query may be narrower (the embedding_model guard), never wider — so each index conjunct
    // must appear in the query. If this fails, someone changed one side without the other and
    // every per-tenant index just became dead weight.
    let dir = process.cwd();
    let source: string | null = null;
    for (let i = 0; i < 6; i++) {
      const candidate = path.join(dir, 'src', 'db', 'models', 'product.ts');
      if (existsSync(candidate)) {
        source = readFileSync(candidate, 'utf8');
        break;
      }
      dir = path.dirname(dir);
    }
    assert.ok(source, 'could not locate product.ts');

    const predicate = tenantIndexPredicate(T1);
    for (const conjunct of ['deleted_at IS NULL', 'is_active = true', 'embedding IS NOT NULL']) {
      assert.ok(predicate.includes(conjunct), `index predicate lost: ${conjunct}`);
      assert.ok(source!.includes(conjunct), `runtime query lost: ${conjunct}`);
    }
    assert.ok(
      source!.includes('tenantHasPartialIndex') && source!.includes('quoteUuidLiteral'),
      'the similarity query must consult the membership check and inline via the validated quoter',
    );
  });
});
