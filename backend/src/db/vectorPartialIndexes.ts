/**
 * P3-2 (RC-04) — per-tenant partial HNSW indexes over `products.embedding`.
 *
 * WHY. The global HNSW index (`idx_products_embedding`, migrations 017/029) ranks every tenant's
 * vectors together and post-filters by `tenant_id` — so a small tenant's true matches can be
 * crowded out of the ef_search candidate pool by larger tenants' vectors. A partial index scoped
 * to one tenant makes that tenant's candidate pool exactly its own catalog.
 *
 * THE PLAN-TIME TRAP THIS FILE EXISTS AROUND. A partial index is only usable when the planner can
 * PROVE the query predicate implies the index predicate — and it can never prove that for a bound
 * parameter (`tenant_id = $1`). The tenant id must appear as a LITERAL in the SQL. That is why
 * `tenantHasPartialIndex` exists for the query path (inline only for tenants that actually have an
 * index) and why `quoteUuidLiteral` refuses anything that is not shaped like a UUID — the literal
 * is interpolated, so the validation IS the injection barrier.
 *
 * RUNTIME DDL, NOT A MIGRATION — deliberately. The index set is data-dependent (which tenants are
 * large this month), and `CREATE INDEX CONCURRENTLY` cannot run in the migration batch transaction
 * anyway. The sweep is a fleet-singleton BullMQ scheduler job (`maintenanceSchedulers`), each DDL
 * statement is issued alone in autocommit, and a failed CONCURRENTLY build (which leaves an
 * INVALID index behind) is detected via `pg_index.indisvalid` and dropped for re-creation.
 *
 * Everything decision-shaped is in the pure `planPartialIndexChanges`; the sweep is the IO shell.
 */
import pool from './pool';
import { knobBool, knobNumber } from '../config/knobs';
import { logger } from '../utils/logger';

export const PARTIAL_INDEX_PREFIX = 'products_embedding_hnsw_t_';

/**
 * The index predicate MUST stay implied by the runtime query in `product.ts`
 * (`searchProductsBySimilarity`): tenant literal + `deleted_at IS NULL AND is_active = true AND
 * embedding IS NOT NULL`. The optional `embedding_model` guard in the query is extra — a query may
 * be narrower than the index, never wider. Pinned by a source invariant in the unit suite.
 */
export function tenantIndexPredicate(tenantId: string): string {
  return (
    `tenant_id = ${quoteUuidLiteral(tenantId)} AND deleted_at IS NULL ` +
    `AND is_active = true AND embedding IS NOT NULL`
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** The injection barrier for literal inlining: UUID shape or throw. */
export function quoteUuidLiteral(tenantId: string): string {
  if (!isUuid(tenantId)) throw new Error(`not a UUID: ${tenantId}`);
  return `'${tenantId.toLowerCase()}'`;
}

/**
 * Deterministic per-tenant index name: prefix + first 16 hex chars of the dash-stripped UUID.
 * 26 + 16 = 42 chars, comfortably under Postgres's 63-char identifier limit; 64 bits of the UUID
 * makes a cross-tenant collision a non-concern at any plausible tenant count.
 */
export function tenantIndexName(tenantId: string): string {
  if (!isUuid(tenantId)) throw new Error(`not a UUID: ${tenantId}`);
  return PARTIAL_INDEX_PREFIX + tenantId.toLowerCase().replace(/-/g, '').slice(0, 16);
}

export interface ExistingPartialIndex {
  name: string;
  valid: boolean;
}

export interface PartialIndexPlan {
  /** Tenant ids to CREATE INDEX CONCURRENTLY for (invalid leftovers are dropped first). */
  create: string[];
  /** Index names to DROP INDEX CONCURRENTLY. */
  drop: string[];
}

/**
 * Pure reconcile decision.
 *
 * - Eligible = rows ≥ minRows, largest first, capped at maxTenants.
 * - HYSTERESIS: an existing index survives until its tenant falls below minRows/2 — a tenant
 *   hovering at the threshold must not churn CONCURRENTLY builds every sweep.
 * - An index whose name maps to no known tenant (tenant deleted) is dropped.
 * - An INVALID index (failed CONCURRENTLY build) is dropped; if its tenant is eligible it is also
 *   re-created — `CREATE ... IF NOT EXISTS` would otherwise skip the corpse forever.
 */
export function planPartialIndexChanges(input: {
  rowsByTenant: Map<string, number>;
  allTenantIds: string[];
  existing: ExistingPartialIndex[];
  minRows: number;
  maxTenants: number;
}): PartialIndexPlan {
  const { rowsByTenant, allTenantIds, existing, minRows, maxTenants } = input;
  const dropFloor = Math.max(1, Math.floor(minRows / 2));

  const nameToTenant = new Map<string, string>();
  for (const id of allTenantIds) {
    if (isUuid(id)) nameToTenant.set(tenantIndexName(id), id);
  }

  const eligible = [...rowsByTenant.entries()]
    .filter(([id, rows]) => rows >= minRows && isUuid(id))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, maxTenants)
    .map(([id]) => id);
  const eligibleSet = new Set(eligible);

  const validNames = new Set(existing.filter((e) => e.valid).map((e) => e.name));
  const drop: string[] = [];
  for (const idx of existing) {
    const tenant = nameToTenant.get(idx.name);
    if (!idx.valid) {
      drop.push(idx.name); // corpse of a failed build — always cleared
      continue;
    }
    if (!tenant) {
      drop.push(idx.name); // tenant deleted
      continue;
    }
    if ((rowsByTenant.get(tenant) ?? 0) < dropFloor) drop.push(idx.name);
  }

  const create = eligible.filter((id) => !validNames.has(tenantIndexName(id)));
  return { create, drop };
}

// ---------------------------------------------------------------------------
// IO shell
// ---------------------------------------------------------------------------

export interface PartialIndexSweepResult {
  skipped: boolean;
  eligible: number;
  created: number;
  dropped: number;
  failed: number;
}

async function listExistingPartialIndexes(): Promise<ExistingPartialIndex[]> {
  const { rows } = await pool.query<{ name: string; valid: boolean }>(
    `SELECT c.relname AS name, i.indisvalid AS valid
       FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE c.relname LIKE $1`,
    [`${PARTIAL_INDEX_PREFIX}%`],
  );
  return rows;
}

/** Never throws — index maintenance must not take a worker down. */
export async function runVectorPartialIndexSweep(): Promise<PartialIndexSweepResult> {
  const empty: PartialIndexSweepResult = { skipped: true, eligible: 0, created: 0, dropped: 0, failed: 0 };
  if (!knobBool('VECTOR_TENANT_PARTIAL_INDEX')) return empty;

  try {
    const minRows = knobNumber('VECTOR_PARTIAL_INDEX_MIN_ROWS');
    const maxTenants = knobNumber('VECTOR_PARTIAL_INDEX_MAX_TENANTS');

    const { rows: counts } = await pool.query<{ tenant_id: string; n: string }>(
      `SELECT tenant_id, COUNT(*)::text AS n
         FROM products
        WHERE deleted_at IS NULL AND is_active = true AND embedding IS NOT NULL
        GROUP BY 1`,
    );
    const rowsByTenant = new Map(counts.map((r) => [r.tenant_id, parseInt(r.n, 10)]));
    const { rows: tenants } = await pool.query<{ id: string }>('SELECT id FROM tenants');

    const plan = planPartialIndexChanges({
      rowsByTenant,
      allTenantIds: tenants.map((t) => t.id),
      existing: await listExistingPartialIndexes(),
      minRows,
      maxTenants,
    });

    let created = 0;
    let dropped = 0;
    let failed = 0;

    // Drops first: an INVALID corpse must be gone before its tenant's re-create.
    for (const name of plan.drop) {
      try {
        // One statement per query call — CONCURRENTLY cannot run in any transaction, including
        // the implicit one node-postgres wraps around multi-statement text.
        await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
        dropped++;
      } catch (err) {
        failed++;
        logger.warn('[vector-index] drop failed', { name, err: message(err) });
      }
    }

    for (const tenantId of plan.create) {
      const name = tenantIndexName(tenantId);
      try {
        await pool.query(
          `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${name}
             ON products USING hnsw (embedding vector_cosine_ops)
             WHERE ${tenantIndexPredicate(tenantId)}`,
        );
        created++;
      } catch (err) {
        failed++;
        logger.warn('[vector-index] create failed (an INVALID index may remain; next sweep clears it)', {
          name,
          tenantId,
          err: message(err),
        });
      }
    }

    invalidateMembershipCache();
    if (created > 0 || dropped > 0 || failed > 0) {
      logger.info('[vector-index] sweep', { eligible: plan.create.length, created, dropped, failed });
    }
    return { skipped: false, eligible: plan.create.length, created, dropped, failed };
  } catch (err) {
    logger.warn('[vector-index] sweep failed', { err: message(err) });
    return { ...empty, skipped: false, failed: 1 };
  }
}

// ---------------------------------------------------------------------------
// Query-side membership (the literal-inlining decision)
// ---------------------------------------------------------------------------

const MEMBERSHIP_TTL_MS = 60_000;
let membership: { at: number; names: Set<string> } | null = null;

export function invalidateMembershipCache(): void {
  membership = null;
}

/**
 * Whether the similarity query should inline this tenant's id as a literal. FAIL-OPEN to `false`
 * on any doubt (flag off, non-UUID id, catalog lookup error): the parameterized global-index path
 * is always correct — inlining is only ever an optimization.
 */
export async function tenantHasPartialIndex(tenantId: string): Promise<boolean> {
  if (!knobBool('VECTOR_TENANT_PARTIAL_INDEX')) return false;
  if (!isUuid(tenantId)) return false;
  try {
    const now = Date.now();
    if (!membership || now - membership.at > MEMBERSHIP_TTL_MS) {
      const existing = await listExistingPartialIndexes();
      membership = { at: now, names: new Set(existing.filter((e) => e.valid).map((e) => e.name)) };
    }
    return membership.names.has(tenantIndexName(tenantId));
  } catch (err) {
    logger.warn('[vector-index] membership lookup failed — using the parameterized path', {
      err: message(err),
    });
    return false;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
