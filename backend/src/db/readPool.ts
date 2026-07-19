/**
 * P3-2 — the read-replica seam.
 *
 * `DATABASE_REPLICA_URL` unset (the default): this module's default export IS the primary pool —
 * the same object, not a copy — so every consumer below behaves byte-identically to before and no
 * second pool exists. Set it to a streaming replica's URL and the analytics read paths that import
 * from here move off the primary with zero code change.
 *
 * WHO MAY IMPORT THIS. Only queries that tolerate replication lag: statistics, dashboards, the
 * admin cost panel. Never CRM reads (inbox, orders, conversations) — a merchant who sends a reply
 * and refreshes must see it, and a replica is entitled to be seconds behind (the read-after-write
 * hazard `poolConfig.ts` deferred this split over). When in doubt, import `db/pool` instead.
 *
 * Follows the `REDIS_URL` posture for infra URLs: default-at-read-site, not a manifest knob —
 * `validateEnv.logPosture` logs which mode the process booted in.
 */
import { Pool } from 'pg';
import pool, { buildPoolConfigFor } from './pool';
import { resolveProcessRole } from '../config/processRole';
import { poolRoleFromProcessRole } from './poolConfig';

export interface ReplicaSettings {
  url: string | null;
  max: number;
}

/** Pure, for tests: how the env resolves. `PG_POOL_MAX_REPLICA` caps the replica pool (default 5). */
export function resolveReplicaSettings(env: NodeJS.ProcessEnv = process.env): ReplicaSettings {
  const url = env.DATABASE_REPLICA_URL?.trim() || null;
  const parsed = parseInt(env.PG_POOL_MAX_REPLICA ?? '', 10);
  return { url, max: Number.isFinite(parsed) && parsed > 0 ? parsed : 5 };
}

const settings = resolveReplicaSettings();

/** True when this process routes analytics reads to a replica. */
export const isReplicaConfigured = settings.url !== null;

function buildReplicaPool(url: string, max: number): Pool {
  const role = poolRoleFromProcessRole(resolveProcessRole());
  const replica = new Pool({
    ...buildPoolConfigFor(url),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `hillside-${role}-ro`,
    // Analytics-only pool: a runaway aggregate must not pin a replica connection forever. 30s is
    // far above any current statistics/cost query and far below "stuck".
    options: '-c statement_timeout=30000',
  });
  replica.on('error', (err) => {
    console.error('[db] Replica idle client error (pool will recover automatically):', err);
  });
  console.info('[db] read replica pool configured', {
    max,
    applicationName: `hillside-${role}-ro`,
  });
  return replica;
}

const readPool: Pool = isReplicaConfigured ? buildReplicaPool(settings.url!, settings.max) : pool;

export default readPool;
