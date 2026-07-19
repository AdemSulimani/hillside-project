/**
 * P3-6 — the COGS read path for the platform admin portal (OBS-2 / C-108).
 *
 * Reads the ledger directly for recent windows and `ai_cost_daily` for anything older, reporting
 * which it used. The SQL here MUST mirror `services/costAggregation.turnCostUsd` exactly:
 *
 *     COALESCE((usage->>'calls_usd_cost')::numeric, (usage->>'usd_cost')::numeric)
 *
 * `calls_usd_cost` is written as `undefined` when no call was priced, so the JSON key is absent,
 * `->>` yields SQL NULL, and COALESCE falls through — the same order the pure function takes.
 * Summing the two columns would DOUBLE-COUNT the main generation, which appears in both.
 */
// P3-2: replica-tolerant analytics reads. With DATABASE_REPLICA_URL unset this IS db/pool.
import pool from '../db/readPool';
import { queryCostDaily } from '../db/models/aiCostDaily';
import { summarizeCogs, type CogsSummary, type CostRollupRow } from './costAggregation';
import { UNATTRIBUTED_ROLE } from './costAggregation';
import type { ModelRole } from '../config/models';

/** The turn-cost expression, written once so the two call sites below cannot drift apart. */
const TURN_COST_SQL = `COALESCE((usage->>'calls_usd_cost')::numeric, (usage->>'usd_cost')::numeric, 0)`;

/**
 * `usage->'calls'` is typed `| null`, so a JSON null is reachable — and `jsonb_array_elements(null)`
 * ERRORS rather than yielding zero rows. `COALESCE` does not catch a JSON null (it is not SQL
 * NULL), so the type must be checked explicitly. Getting this wrong turns the admin panel into a
 * 500 the first time a turn records no calls.
 */
const CALLS_ARRAY_SQL = `CASE WHEN jsonb_typeof(l.usage->'calls') = 'array'
                              THEN l.usage->'calls' ELSE '[]'::jsonb END`;

export interface CostPeriodStats extends CogsSummary {
  /** How many ledger rows the window actually held. 0 with a live ledger flag means "no traffic". */
  rows_in_window: number;
  /** Turns whose `usage` was null entirely — recorded, but with nothing to cost. */
  turns_without_usage: number;
  /**
   * Whether THIS process has the ledger flag on. Explicitly named a hint: the ledger is written by
   * WORKER processes and this endpoint is served by the API, so in a split topology (P3-2) the two
   * can legitimately disagree. Reporting it as fact would be the RC-06 drift class in miniature.
   */
  ledger_enabled_on_this_process: boolean;
  source: 'ledger' | 'rollup';
}

function emptySummary(): CogsSummary {
  return summarizeCogs([]);
}

/** Per-(role, model, kind) breakdown for one tenant over a UTC half-open range, from the ledger. */
async function breakdownFromLedger(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<CostRollupRow[]> {
  const { rows } = await pool.query<{
    role: string;
    model: string;
    kind: string;
    calls: string;
    priced_calls: string;
    prompt_tokens: string;
    cached_tokens: string;
    completion_tokens: string;
    usd_cost: string;
  }>(
    `SELECT COALESCE(c->>'role', $4)                        AS role,
            COALESCE(c->>'served', c->>'requested', 'unknown') AS model,
            COALESCE(c->>'kind', 'unknown')                 AS kind,
            COUNT(*)::text                                  AS calls,
            COUNT(*) FILTER (WHERE c->>'usd_cost' IS NOT NULL)::text AS priced_calls,
            COALESCE(SUM((c->>'prompt_tokens')::bigint), 0)::text     AS prompt_tokens,
            COALESCE(SUM((c->>'cached_tokens')::bigint), 0)::text     AS cached_tokens,
            COALESCE(SUM((c->>'completion_tokens')::bigint), 0)::text AS completion_tokens,
            COALESCE(SUM((c->>'usd_cost')::numeric), 0)::text         AS usd_cost
       FROM ai_decision_ledger l
       CROSS JOIN LATERAL jsonb_array_elements(${CALLS_ARRAY_SQL}) AS c
      WHERE l.tenant_id = $1 AND l.created_at >= $2 AND l.created_at < $3
      GROUP BY 1, 2, 3`,
    [tenantId, from, to, UNATTRIBUTED_ROLE],
  );

  return rows.map((r) => ({
    role: r.role as ModelRole | typeof UNATTRIBUTED_ROLE,
    model: r.model,
    kind: r.kind,
    source: 'reply' as const,
    calls: parseInt(r.calls, 10),
    priced_calls: parseInt(r.priced_calls, 10),
    prompt_tokens: parseInt(r.prompt_tokens, 10),
    cached_tokens: parseInt(r.cached_tokens, 10),
    completion_tokens: parseInt(r.completion_tokens, 10),
    usd_cost: parseFloat(r.usd_cost),
    turns: 0,
    conversations: 0,
  }));
}

/** Turn/conversation counters, which the per-call breakdown above cannot produce. */
async function turnCountsFromLedger(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<{ turns: number; conversations: number; rows: number; withoutUsage: number }> {
  const { rows } = await pool.query<{
    turns: string;
    conversations: string;
    rows: string;
    without_usage: string;
  }>(
    `SELECT COUNT(*) FILTER (WHERE usage IS NOT NULL)::text AS turns,
            COUNT(DISTINCT conversation_id)::text           AS conversations,
            COUNT(*)::text                                  AS rows,
            COUNT(*) FILTER (WHERE usage IS NULL)::text     AS without_usage
       FROM ai_decision_ledger
      WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
    [tenantId, from, to],
  );
  const r = rows[0];
  return {
    turns: parseInt(r?.turns ?? '0', 10),
    conversations: parseInt(r?.conversations ?? '0', 10),
    rows: parseInt(r?.rows ?? '0', 10),
    withoutUsage: parseInt(r?.without_usage ?? '0', 10),
  };
}

/** Per-tenant COGS for a UTC half-open range, read live from the ledger. */
export async function getTenantCostPeriodStats(
  tenantId: string,
  from: Date,
  to: Date,
  ledgerEnabledHere: boolean,
): Promise<CostPeriodStats> {
  const [breakdown, counts] = await Promise.all([
    breakdownFromLedger(tenantId, from, to),
    turnCountsFromLedger(tenantId, from, to),
  ]);

  const summary = breakdown.length > 0 ? summarizeCogs(breakdown) : emptySummary();
  return {
    ...summary,
    // The per-call breakdown cannot count turns or conversations (it is one row per CALL), so the
    // real counters come from the row-level query and overwrite the fold's zeros.
    turns: counts.turns,
    conversations: counts.conversations,
    usd_per_turn: counts.turns > 0 ? Math.round((summary.usd_cost / counts.turns) * 1e6) / 1e6 : null,
    usd_per_conversation:
      counts.conversations > 0
        ? Math.round((summary.usd_cost / counts.conversations) * 1e6) / 1e6
        : null,
    rows_in_window: counts.rows,
    turns_without_usage: counts.withoutUsage,
    ledger_enabled_on_this_process: ledgerEnabledHere,
    source: 'ledger',
  };
}

/** Per-tenant COGS from the durable rollup — the only path that works past ledger retention. */
export async function getTenantCostFromRollup(
  tenantId: string,
  fromDay: string,
  toDay: string,
  ledgerEnabledHere: boolean,
): Promise<CostPeriodStats> {
  const rows = await queryCostDaily({ tenantId, from: fromDay, to: toDay });
  const summary = rows.length > 0 ? summarizeCogs(rows) : emptySummary();
  return {
    ...summary,
    rows_in_window: rows.length,
    turns_without_usage: 0,
    ledger_enabled_on_this_process: ledgerEnabledHere,
    source: 'rollup',
  };
}

export interface FleetCostRow {
  tenant_id: string;
  tenant_name: string | null;
  usd_cost: number;
  turns: number;
  calls: number;
}

/** Fleet-wide per-tenant spend for the admin dashboard, newest-first by cost. */
export async function getFleetCostSummary(from: Date, to: Date, limit = 50): Promise<FleetCostRow[]> {
  const { rows } = await pool.query<{
    tenant_id: string;
    tenant_name: string | null;
    usd_cost: string;
    turns: string;
    calls: string;
  }>(
    `SELECT l.tenant_id,
            t.name AS tenant_name,
            COALESCE(SUM(${TURN_COST_SQL}), 0)::text                  AS usd_cost,
            COUNT(*) FILTER (WHERE l.usage IS NOT NULL)::text         AS turns,
            COALESCE(SUM(COALESCE((l.usage->>'call_count')::int, 0)), 0)::text AS calls
       FROM ai_decision_ledger l
       LEFT JOIN tenants t ON t.id = l.tenant_id
      WHERE l.created_at >= $1 AND l.created_at < $2
      GROUP BY 1, 2
      ORDER BY COALESCE(SUM(${TURN_COST_SQL}), 0) DESC
      LIMIT $3`,
    [from, to, limit],
  );
  return rows.map((r) => ({
    tenant_id: r.tenant_id,
    tenant_name: r.tenant_name,
    usd_cost: parseFloat(r.usd_cost),
    turns: parseInt(r.turns, 10),
    calls: parseInt(r.calls, 10),
  }));
}

/** The worst single conversation and turn in a window — the runaway-cost anomaly inputs. */
export async function getCostOutliers(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<{
  worstConversation: { conversationId: string; usdCost: number } | null;
  worstTurn: { conversationId: string | null; calls: number } | null;
}> {
  const [conv, turn] = await Promise.all([
    pool.query<{ conversation_id: string; usd_cost: string }>(
      `SELECT conversation_id, SUM(${TURN_COST_SQL})::text AS usd_cost
         FROM ai_decision_ledger
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
          AND conversation_id IS NOT NULL
        GROUP BY 1 ORDER BY SUM(${TURN_COST_SQL}) DESC LIMIT 1`,
      [tenantId, from, to],
    ),
    pool.query<{ conversation_id: string | null; calls: string }>(
      `SELECT conversation_id, COALESCE((usage->>'call_count')::int, 0)::text AS calls
         FROM ai_decision_ledger
        WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3
        ORDER BY COALESCE((usage->>'call_count')::int, 0) DESC LIMIT 1`,
      [tenantId, from, to],
    ),
  ]);

  const c = conv.rows[0];
  const t = turn.rows[0];
  return {
    worstConversation: c ? { conversationId: c.conversation_id, usdCost: parseFloat(c.usd_cost) } : null,
    worstTurn: t ? { conversationId: t.conversation_id, calls: parseInt(t.calls, 10) } : null,
  };
}

/** Distinct served models per role in a window — the model-drift anomaly input (RC-17). */
export async function getModelsByRole(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<Record<string, string[]>> {
  const { rows } = await pool.query<{ role: string; models: string[] }>(
    `SELECT COALESCE(c->>'role', $4) AS role,
            ARRAY_AGG(DISTINCT COALESCE(c->>'served', c->>'requested', 'unknown')) AS models
       FROM ai_decision_ledger l
       CROSS JOIN LATERAL jsonb_array_elements(${CALLS_ARRAY_SQL}) AS c
      WHERE l.tenant_id = $1 AND l.created_at >= $2 AND l.created_at < $3
      GROUP BY 1`,
    [tenantId, from, to, UNATTRIBUTED_ROLE],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) out[r.role] = r.models;
  return out;
}
