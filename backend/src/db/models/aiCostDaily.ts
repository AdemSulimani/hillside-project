/**
 * P3-6 — data access for `ai_cost_daily` (migration 087).
 *
 * The SQL half of the pure/IO split; the arithmetic lives in `services/costAggregation.ts` and is
 * unit-tested with no database. The integration test asserts both halves produce the same numbers
 * over the same rows, which is the only thing that keeps the split honest.
 */
import pool from '../pool';
import type { PoolClient } from 'pg';
import type { CostRollupRow, CostSource } from '../../services/costAggregation';

type Db = PoolClient | typeof pool;

export interface CostDailyRow extends CostRollupRow {
  tenant_id: string;
  day: string;
  computed_at: Date;
  sealed_at: Date | null;
}

interface RawCostDailyRow {
  tenant_id: string;
  day: string;
  role: string;
  model: string;
  kind: string;
  source: string;
  calls: string;
  priced_calls: string;
  prompt_tokens: string;
  cached_tokens: string;
  completion_tokens: string;
  usd_cost: string;
  turns: string;
  conversations: string;
  computed_at: Date;
  sealed_at: Date | null;
}

/** `pg` returns BIGINT and NUMERIC as strings to avoid precision loss — parse at the boundary. */
function mapRow(r: RawCostDailyRow): CostDailyRow {
  return {
    tenant_id: r.tenant_id,
    day: typeof r.day === 'string' ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10),
    role: r.role as CostRollupRow['role'],
    model: r.model,
    kind: r.kind,
    source: r.source as CostSource,
    calls: parseInt(r.calls, 10),
    priced_calls: parseInt(r.priced_calls, 10),
    prompt_tokens: parseInt(r.prompt_tokens, 10),
    cached_tokens: parseInt(r.cached_tokens, 10),
    completion_tokens: parseInt(r.completion_tokens, 10),
    usd_cost: parseFloat(r.usd_cost),
    turns: parseInt(r.turns, 10),
    conversations: parseInt(r.conversations, 10),
    computed_at: r.computed_at,
    sealed_at: r.sealed_at,
  };
}

const SELECT_COLS = `tenant_id, to_char(day, 'YYYY-MM-DD') AS day, role, model, kind, source,
                     calls, priced_calls, prompt_tokens, cached_tokens, completion_tokens,
                     usd_cost, turns, conversations, computed_at, sealed_at`;

/**
 * Replace a whole (tenant_id, day, source) partition with a freshly-computed set of rows.
 *
 * RECOMPUTE, NOT INCREMENT — and the reason is `conversations`. A distinct-conversation count
 * cannot be summed across two partial sweeps (the same conversation spans both), so an
 * incremental upsert would inflate it monotonically. Deleting and re-inserting the partition
 * inside one transaction makes the sweep idempotent and re-runnable, which is what lets it
 * simply re-fold a trailing window every tick instead of maintaining a watermark that can drift
 * out of sync with the data it claims to describe.
 *
 * Refuses to touch a SEALED day: see `sealCostDays`.
 */
export async function replaceCostDay(
  client: Db,
  args: { tenantId: string; day: string; source: CostSource; rows: CostRollupRow[] },
): Promise<number> {
  const sealed = await client.query<{ sealed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM ai_cost_daily
       WHERE tenant_id = $1 AND day = $2::date AND source = $3 AND sealed_at IS NOT NULL
     ) AS sealed`,
    [args.tenantId, args.day, args.source],
  );
  if (sealed.rows[0]?.sealed) return 0;

  await client.query(
    'DELETE FROM ai_cost_daily WHERE tenant_id = $1 AND day = $2::date AND source = $3',
    [args.tenantId, args.day, args.source],
  );
  if (args.rows.length === 0) return 0;

  // One multi-row INSERT rather than N statements: a busy tenant-day can hold a few dozen
  // (role, model, kind) combinations and this runs inside the sweep's transaction.
  const COLS = 14;
  const values: unknown[] = [];
  const tuples = args.rows.map((r, i) => {
    const b = i * COLS;
    values.push(
      args.tenantId,
      args.day,
      r.role,
      r.model,
      r.kind,
      args.source,
      r.calls,
      r.priced_calls,
      r.prompt_tokens,
      r.cached_tokens,
      r.completion_tokens,
      r.usd_cost,
      r.turns,
      r.conversations,
    );
    const p = Array.from({ length: COLS }, (_, k) => `$${b + k + 1}`);
    // day is the 2nd column and needs the ::date cast.
    p[1] = `${p[1]}::date`;
    return `(${p.join(', ')})`;
  });

  await client.query(
    `INSERT INTO ai_cost_daily
       (tenant_id, day, role, model, kind, source,
        calls, priced_calls, prompt_tokens, cached_tokens, completion_tokens, usd_cost,
        turns, conversations)
     VALUES ${tuples.join(', ')}`,
    values,
  );

  return args.rows.length;
}

/**
 * Seal every day older than `sealDays` that is not already sealed.
 *
 * A sealed day is frozen forever. The horizon must stay well below `LEDGER_RETENTION_DAYS`,
 * because sealing is what stops a later sweep from recomputing a day whose ledger rows have been
 * partly pruned and silently reporting a smaller number than the truth.
 */
export async function sealCostDays(sealDays: number, client: Db = pool): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE ai_cost_daily
        SET sealed_at = now()
      WHERE sealed_at IS NULL
        AND day < (now() AT TIME ZONE 'UTC')::date - ($1::int)`,
    [sealDays],
  );
  return rowCount ?? 0;
}

export interface CostDailyQuery {
  tenantId?: string;
  /** Inclusive 'YYYY-MM-DD'. */
  from: string;
  /** Inclusive 'YYYY-MM-DD'. */
  to: string;
  source?: CostSource;
}

export async function queryCostDaily(q: CostDailyQuery, client: Db = pool): Promise<CostDailyRow[]> {
  const params: unknown[] = [q.from, q.to];
  let where = 'day >= $1::date AND day <= $2::date';
  if (q.tenantId) {
    params.push(q.tenantId);
    where += ` AND tenant_id = $${params.length}`;
  }
  if (q.source) {
    params.push(q.source);
    where += ` AND source = $${params.length}`;
  }
  const { rows } = await client.query<RawCostDailyRow>(
    `SELECT ${SELECT_COLS} FROM ai_cost_daily WHERE ${where} ORDER BY day ASC, usd_cost DESC`,
    params,
  );
  return rows.map(mapRow);
}

/** Retention prune. Bounded per call so a backlog never holds a long transaction. */
export async function pruneCostDaily(
  retentionDays: number,
  batchSize = 5000,
  client: Db = pool,
): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM ai_cost_daily
      WHERE ctid IN (
        SELECT ctid FROM ai_cost_daily
         WHERE day < (now() AT TIME ZONE 'UTC')::date - ($1::int)
         LIMIT $2
      )`,
    [retentionDays, batchSize],
  );
  return rowCount ?? 0;
}

/**
 * Record background-job spend (product imports, image fingerprinting) directly.
 *
 * These never reach `ai_decision_ledger` — that table is reply-scoped and its NOT NULL
 * `decision_kind`/`reply_slot` columns do not describe an import job. Writing them here keeps the
 * ledger's per-turn grain intact while still making the spend visible in the same admin panel.
 *
 * Additive upsert (not the replace above): a job's spend is a fact that happened once, so
 * accumulating is correct, and jobs carry no distinct-conversation count to spoil.
 */
export async function addJobCost(
  args: {
    tenantId: string;
    day: string;
    role: string;
    model: string;
    kind: string;
    calls: number;
    pricedCalls: number;
    promptTokens: number;
    cachedTokens: number;
    completionTokens: number;
    usdCost: number;
  },
  client: Db = pool,
): Promise<void> {
  await client.query(
    `INSERT INTO ai_cost_daily
       (tenant_id, day, role, model, kind, source,
        calls, priced_calls, prompt_tokens, cached_tokens, completion_tokens, usd_cost)
     VALUES ($1, $2::date, $3, $4, $5, 'job', $6, $7, $8, $9, $10, $11)
     ON CONFLICT (tenant_id, day, role, model, kind, source) DO UPDATE SET
       calls             = ai_cost_daily.calls + EXCLUDED.calls,
       priced_calls      = ai_cost_daily.priced_calls + EXCLUDED.priced_calls,
       prompt_tokens     = ai_cost_daily.prompt_tokens + EXCLUDED.prompt_tokens,
       cached_tokens     = ai_cost_daily.cached_tokens + EXCLUDED.cached_tokens,
       completion_tokens = ai_cost_daily.completion_tokens + EXCLUDED.completion_tokens,
       usd_cost          = ai_cost_daily.usd_cost + EXCLUDED.usd_cost,
       computed_at       = now()
     WHERE ai_cost_daily.sealed_at IS NULL`,
    [
      args.tenantId,
      args.day,
      args.role,
      args.model,
      args.kind,
      args.calls,
      args.pricedCalls,
      args.promptTokens,
      args.cachedTokens,
      args.completionTokens,
      args.usdCost,
    ],
  );
}
