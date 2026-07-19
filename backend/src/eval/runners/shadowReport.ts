/**
 * P3-4 — the shadow-diff report runner. `npm run eval:shadow`
 *
 * Reads `ai_decision_ledger` and reports, per classifier, how often the deterministic replacement
 * agreed with the legacy path on real traffic. This is the gate P3-1's cutovers are decided on:
 * "run a retired classifier and its deterministic replacement side by side on real traffic before
 * cutover".
 *
 * READS ONLY. No writes, no OpenAI calls, no cost. Needs `DATABASE_URL`.
 *
 * The aggregation itself lives in the pure `harness/shadowDiff.ts` and is unit-tested offline; this
 * file is only the query and the presentation. That split is deliberate — the arithmetic that
 * decides a cutover should not be reachable only through a database.
 *
 *   npx tsx src/eval/runners/shadowReport.ts                        # all classifiers, last 7 days
 *   npx tsx src/eval/runners/shadowReport.ts --classifier=order_stage
 *   npx tsx src/eval/runners/shadowReport.ts --days=30 --tenant=<uuid> --json
 *   npx tsx src/eval/runners/shadowReport.ts --min-percent=99 --min-rows=500   # exit 1 if unmet
 */
// Operator CLI, not a CI module: load backend/.env first (FIRST import — later imports may
// freeze knob/env reads at module load). CI-side eval modules stay dotenv-free by fence.
import 'dotenv/config';
import pool from '../../db/pool';
import { scanLedger, type LedgerRow } from '../../db/models/aiDecisionLedger';
import {
  buildShadowDiffReport,
  meetsCutoverBar,
  parseShadowBranch,
  type ShadowDiffRow,
} from '../harness/shadowDiff';

interface Args {
  classifier?: string;
  tenantId?: string;
  days: number;
  json: boolean;
  minPercent?: number;
  minRows: number;
  maxRows: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
  const num = (name: string, fallback?: number): number | undefined => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`--${name} must be a number, got "${raw}"`);
    return v;
  };
  return {
    classifier: get('classifier'),
    tenantId: get('tenant'),
    days: num('days', 7)!,
    json: argv.includes('--json'),
    minPercent: num('min-percent'),
    minRows: num('min-rows', 100)!,
    maxRows: num('max-rows', 200_000)!,
  };
}

/**
 * The `since` bound is computed from a clock read, which is why this runner lives here and not in
 * a corpus module: `src/eval/**` bans clock reads for anything the CI gate touches, and a report
 * over "the last N days" is exactly the kind of thing that must never gate a merge.
 */
function sinceDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const since = sinceDate(args.days);

  /**
   * The report buffers rows because `buildShadowDiffReport` folds over the whole set. That is fine
   * for a bake-in window and NOT fine for an unbounded one, so the cap is explicit and, crucially,
   * announced: a truncated window would otherwise look exactly like a quiet one, and a cutover
   * decision made from it would be wrong in the direction that looks safe.
   */
  const rows: ShadowDiffRow[] = [];
  const classifiers = new Set<string>();
  let truncated = false;
  for await (const row of scanLedger({ tenantId: args.tenantId, since })) {
    if (rows.length >= args.maxRows) {
      truncated = true;
      break;
    }
    const r = row as LedgerRow;
    rows.push({
      idempotency_key: r.idempotency_key,
      conversation_id: r.conversation_id,
      created_at: r.created_at,
      decision_events: r.decision_events ?? [],
    });
    for (const e of r.decision_events ?? []) {
      // Only classifiers that actually emit a shadow branch are reportable. A `decision_event`
      // with branch 'flagged' is a normal gate record, not a comparison.
      if (parseShadowBranch(e.branch).kind !== 'other') classifiers.add(e.classifier);
    }
  }

  const targets = args.classifier ? [args.classifier] : [...classifiers].sort();
  const reports = targets.map((c) => buildShadowDiffReport(c, rows));

  if (args.json) {
    console.log(
      JSON.stringify(
        { since: since.toISOString(), days: args.days, ledgerRows: rows.length, truncated, reports },
        null,
        2,
      ),
    );
  } else {
    console.info(`[eval:shadow] ${rows.length} ledger rows since ${since.toISOString()}`);
    if (truncated) {
      console.warn(
        `[eval:shadow] ⚠️  TRUNCATED at --max-rows=${args.maxRows}. The window holds more rows than ` +
          'were read, so these percentages describe a PREFIX of it. Narrow --days or raise ' +
          '--max-rows before treating this as a cutover decision.',
      );
    }
    if (rows.length === 0) {
      // Not an error, and worth saying plainly: AI_DECISION_LEDGER_ENABLED defaults to false, so an
      // empty ledger is the expected state until it is turned on.
      console.info(
        '[eval:shadow] the ledger is empty for this window. AI_DECISION_LEDGER_ENABLED defaults to ' +
          'false — turn it on (with the P1-1 outbox flags) to collect shadow data.',
      );
    }
    if (targets.length === 0) {
      console.info('[eval:shadow] no classifier emitted a shadow branch in this window.');
    }
    for (const r of reports) {
      console.info(
        `\n  ${r.classifier}: ${r.agreementPercent}% agreement over ${r.total} observations ` +
          `(${r.agree} agree / ${r.diverge} diverge${r.other ? `, ${r.other} non-shadow events` : ''})`,
      );
      for (const b of r.byContext) {
        console.info(`     ${b.context.padEnd(32)} ${b.agreementPercent}%  (${b.diverge}/${b.total} diverged)`);
      }
      for (const ex of r.divergenceExamples) {
        console.info(`     ↳ ${ex.createdAt}  conv=${ex.conversationId ?? '-'}  ${ex.branch}`);
      }
    }
  }

  if (args.minPercent !== undefined) {
    const failures = reports
      .map((r) => ({ r, v: meetsCutoverBar(r, { minPercent: args.minPercent!, minRows: args.minRows }) }))
      .filter(({ v }) => !v.pass);
    for (const { r, v } of failures) {
      console.error(`[eval:shadow] CUTOVER BAR NOT MET — ${r.classifier}: ${v.reason}`);
    }
    if (failures.length > 0) process.exitCode = 1;
  }
}

// Only runs when invoked directly, never on import.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[eval:shadow] failed', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}
