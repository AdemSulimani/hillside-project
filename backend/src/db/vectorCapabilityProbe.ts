/**
 * P3-2 Step 3 — the pool-backed probe for `db/vectorCapability.ts`.
 *
 * Kept separate so `vectorCapability.ts` stays a decision leaf with no `pg` import: the interpretation
 * logic is unit-testable with no database, and only this file opens a connection.
 */
import pool from './pool';
import { initVectorCapability } from './vectorCapability';

/**
 * One statement, doing two things in a deliberate order:
 *
 *  - the `<=>` operator on a `vector` literal forces Postgres to LOAD the pgvector library into
 *    this session. Without it the `hnsw.*` GUCs are not registered yet and the setting read below
 *    returns NULL even on a perfectly capable 0.8.2 server (verified — a bare `pg_settings` query
 *    on a fresh connection returns zero `hnsw%` rows);
 *  - `current_setting(…, true)` passes `missing_ok`, so an older pgvector answers NULL instead of
 *    raising. That is what lets "extension missing", "version too old" and "database unreachable"
 *    all collapse to `supported = false` rather than to a throw.
 */
const PROBE_SQL = `
  SELECT current_setting('hnsw.iterative_scan', true) AS iterative_scan
  FROM (SELECT '[1,2]'::vector <=> '[2,1]'::vector) AS _load_vector
`;

/**
 * Probe once at boot. Best-effort by contract: never awaited on the critical path and never throws,
 * because failing to detect the capability only means keeping today's adaptive-retry behaviour.
 */
export async function initVectorCapabilityFromPool(): Promise<void> {
  await initVectorCapability(async () => {
    const { rows } = await pool.query<{ iterative_scan: string | null }>(PROBE_SQL);
    return { iterativeScan: rows[0]?.iterative_scan ?? null };
  });
}
