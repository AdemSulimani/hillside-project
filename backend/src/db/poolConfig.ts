/**
 * P3-2 Step 10 — role-aware Postgres pool sizing and per-role session settings.
 *
 * `db/pool.ts` exports ONE default-exported `Pool`, and all 65 import sites use the bare default
 * form. So the pool is made role-aware by changing its CONFIGURATION, not by introducing a second
 * exported pool that 65 call sites would each have to choose between. (A read-replica split genuinely
 * does need that per-call-site decision — `statisticsService` is replica-safe, `processAIReply` and
 * `outbox.ts` are read-after-write and are not — which is exactly why it is out of scope here.)
 *
 * Three settings that do not exist at all today and matter more than the sizing:
 *
 *   - `application_name`. Every row in `pg_stat_activity` is currently anonymous, so "did the split
 *     actually take effect" is unanswerable in production. This one line makes it a query.
 *   - `statement_timeout`. There is none anywhere. The API wants one (a runaway query should not
 *     hold a request open); the worker must NOT have one, because `reconcileProductEmbeddings`,
 *     `prepareFinetuning` and `monthlyUseCaseSnapshot` run legitimately long. That divergence is the
 *     actual reason to make the pool role-aware — it cannot be expressed with a single global value.
 *   - `idle_in_transaction_session_timeout`. `searchProductsBySimilarity` and the outbox relay both
 *     hold explicit BEGIN/COMMIT blocks with no bound. A client that hangs mid-transaction blocks
 *     autovacuum on `products`, and on a pgvector table bloat becomes an outage rather than a
 *     slowdown.
 *
 * Pure module: no `pg` import, no side effects. `db/pool.ts` applies the result.
 */
import type { ProcessRole } from '../config/processRole';

/** Pool identity, derived from PROCESS_ROLE but not identical to it — CLI scripts are neither. */
export type PoolRole = 'api' | 'worker' | 'all' | 'cli';

export interface RolePoolSettings {
  role: PoolRole;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  applicationName: string;
  /** ms; 0 disables. Applied as a connection-level `options` parameter. */
  statementTimeoutMs: number;
  /** ms; 0 disables. */
  idleInTransactionTimeoutMs: number;
}

/**
 * Per-role connection budgets.
 *
 * Sized against `max_connections=80` on a Postgres container limited to 640M with
 * `shared_buffers=192MB` — roughly 448M for backends, and a backend costs ~7MB before it sorts
 * anything. 80 is therefore already more than that container can actually service; the budget here
 * (api 10 + worker 12 = 22, plus migrations and psql) leaves generous headroom deliberately, and
 * `max_connections` should come DOWN before it ever goes up.
 *
 * The worker gets more than the API because its 22 concurrent job slots (webhook 10, AI 5,
 * notifications 3, finetuning 1, default 3 at the code defaults) exceed the API's request
 * concurrency, and because `processInboundMessage` documents a job holding one client while
 * awaiting another — so the budget must exceed peak NESTED acquisitions, not just peak jobs.
 */
export const ROLE_POOL_DEFAULTS: Record<
  PoolRole,
  { max: number; statementTimeoutMs: number; idleInTransactionTimeoutMs: number }
> = {
  /**
   * `all` is the LEGACY topology — what every current deployment runs — so it must be
   * byte-identical to the pre-split configuration. That means no session timeouts of any kind:
   * there were none before, and `db/migrate.ts` takes its client from this same pool. A migration
   * batch that idles between statements longer than the timeout would be killed mid-run, turning a
   * safety net into a deploy failure. Opting into the timeouts is what choosing an explicit role is.
   */
  all: { max: 10, statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 },
  api: { max: 10, statementTimeoutMs: 15_000, idleInTransactionTimeoutMs: 60_000 },
  // No statement timeout: reconcile/finetuning/snapshot jobs legitimately run for minutes. The
  // idle-in-transaction bound still applies — it targets a HUNG client, not a slow query.
  worker: { max: 12, statementTimeoutMs: 0, idleInTransactionTimeoutMs: 60_000 },
  // CLI scripts include the migration runner. Neither timeout, for the reason given under `all`.
  cli: { max: 4, statementTimeoutMs: 0, idleInTransactionTimeoutMs: 0 },
};

const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

export function poolRoleFromProcessRole(role: ProcessRole): PoolRole {
  return role;
}

function readInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  // Zero is meaningful for the two timeouts (disable), so allow it; a pool `max` of 0 would
  // deadlock every query, and callers guard that separately.
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the settings for a role.
 *
 * Override precedence for `max`: `PG_POOL_MAX_<ROLE>` → `PG_POOL_MAX` → the role default. Keeping
 * the existing global as a middle rung means a host that already sets `PG_POOL_MAX` keeps working
 * exactly as before, in both roles.
 */
export function buildRolePoolSettings(input: {
  role: PoolRole;
  env?: NodeJS.ProcessEnv;
}): RolePoolSettings {
  const env = input.env ?? process.env;
  const role = input.role;
  const defaults = ROLE_POOL_DEFAULTS[role];

  const roleSpecific = env[`PG_POOL_MAX_${role.toUpperCase()}`];
  const globalMax = env.PG_POOL_MAX;
  const max = Math.max(
    1,
    readInt(roleSpecific, readInt(globalMax, defaults.max)),
  );

  return {
    role,
    max,
    idleTimeoutMillis: readInt(env.PG_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    connectionTimeoutMillis: readInt(env.PG_CONNECTION_TIMEOUT_MS, DEFAULT_CONNECTION_TIMEOUT_MS),
    applicationName: `hillside-${role}`,
    statementTimeoutMs: readInt(env.PG_STATEMENT_TIMEOUT_MS, defaults.statementTimeoutMs),
    idleInTransactionTimeoutMs: readInt(
      env.PG_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      defaults.idleInTransactionTimeoutMs,
    ),
  };
}

/**
 * The libpq `options` string carrying the per-session GUCs.
 *
 * Returns `undefined` when there is nothing to set, so the connection parameters stay byte-identical
 * to today for any role that disables both. Values are emitted as integers only — they are derived
 * from `parseInt`, never interpolated from raw input.
 */
export function buildSessionOptions(settings: RolePoolSettings): string | undefined {
  const parts: string[] = [];
  if (settings.statementTimeoutMs > 0) {
    parts.push(`-c statement_timeout=${Math.floor(settings.statementTimeoutMs)}`);
  }
  if (settings.idleInTransactionTimeoutMs > 0) {
    parts.push(
      `-c idle_in_transaction_session_timeout=${Math.floor(settings.idleInTransactionTimeoutMs)}`,
    );
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Total connections a fleet would open, for the boot budget WARNING.
 *
 * A warning and never a fatal: refusing to start because a capacity estimate looks tight would turn
 * a tuning question into an outage, and the estimate cannot know about PgBouncer or a replica.
 */
export function expectedFleetConnections(input: {
  apiReplicas: number;
  workerReplicas: number;
  apiMax: number;
  workerMax: number;
  /** Headroom for migrations, psql sessions and ad-hoc tooling. */
  reserved?: number;
}): number {
  const reserved = input.reserved ?? 10;
  return input.apiReplicas * input.apiMax + input.workerReplicas * input.workerMax + reserved;
}
