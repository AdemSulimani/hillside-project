/**
 * P3-4 (RC-15) — the quality-eval PARITY report. `npm run eval:quality`
 *
 * This is the remediation plan's step 4, made concrete: "relocate the in-line eval … run in parallel
 * (log-only) to confirm scores match, then remove the in-line call."
 *
 * HOW THE COMPARISON IS OBTAINED WITHOUT RUNNING TWO EVALS ON THE CUSTOMER'S TURN. The inline score
 * is ALREADY recorded — `processAIReply` writes a P1-5 `decision_event` with
 * `{classifier: 'quality_eval', raw_score, threshold, branch}` on every reply. So the "parallel"
 * half is just history: set `QUALITY_EVAL_MODE=shadow` (scores still recorded, nothing paused),
 * let it run, then point this runner at the window. No new instrumentation, and no period where a
 * miscalibrated score can pause a customer mid-checkout.
 *
 * ⚠️ THE LEDGER DOES NOT STORE THE MESSAGE TEXT — and it must not. `prompt.preview` is the SYSTEM
 * prompt, PII-masked under P1-6. Re-scoring therefore needs the inbound and the reply, which means
 * joining `messages` on `message_id`. That is why this runner is DB-coupled and can never be a CI
 * test, and it is the single fact most likely to surprise someone extending it.
 *
 * ⚠️ PAID + STOCHASTIC (it calls the eval model). Never in CI. `--dry-run` reports how many turns
 * WOULD be re-scored and makes zero OpenAI calls.
 *
 *   npx tsx src/eval/quality/parityReport.ts --days=7 --dry-run
 *   npx tsx src/eval/quality/parityReport.ts --days=7 --limit=200
 *   npx tsx src/eval/quality/parityReport.ts --days=7 --limit=200 --json
 *
 * ACCEPTANCE for flipping `QUALITY_EVAL_MODE=off`: zero flag/would-flag disagreements and a max
 * absolute delta below a stated epsilon, over a stated volume. Both are printed.
 */
import pool from '../../db/pool';
import { scanLedger, type LedgerRow } from '../../db/models/aiDecisionLedger';
import { getQualityThreshold } from '../../services/aiQualityContract';
import type { ScorableTurn } from './offlineScorer';

interface Args {
  days: number;
  limit: number;
  tenantId?: string;
  dryRun: boolean;
  json: boolean;
  epsilon: number;
}

function parseArgs(argv: string[]): Args {
  const get = (n: string): string | undefined =>
    argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const num = (n: string, d: number): number => {
    const raw = get(n);
    if (raw === undefined) return d;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`--${n} must be a number, got "${raw}"`);
    return v;
  };
  return {
    days: num('days', 7),
    limit: num('limit', 100),
    tenantId: get('tenant'),
    // Dry run is NOT the default here (unlike the live-replay runner): this is the report someone
    // explicitly asks for, and its cost is bounded by --limit. But it is available, and it is what
    // the nightly workflow uses.
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
    epsilon: num('epsilon', 0.1),
  };
}

interface ParityRow {
  idempotencyKey: string;
  conversationId: string | null;
  inlineScore: number;
  inlineWouldFlag: boolean;
  offlineScore: number | null;
  offlineWouldFlag: boolean | null;
  delta: number | null;
}

/** Pull the inbound + reply text for a ledger row. The ledger deliberately holds neither. */
async function loadTurnText(row: LedgerRow): Promise<ScorableTurn | null> {
  if (!row.message_id) return null;
  const { rows } = await pool.query(
    `SELECT m.content AS reply,
            m.conversation_id,
            t.name  AS business_name,
            (SELECT content FROM messages prev
              WHERE prev.conversation_id = m.conversation_id
                AND prev.direction = 'inbound'
                AND prev.created_at <= m.created_at
              ORDER BY prev.created_at DESC LIMIT 1) AS inbound
       FROM messages m
       LEFT JOIN tenants t ON t.id = m.tenant_id
      WHERE m.id = $1`,
    [row.message_id],
  );
  const r = rows[0];
  if (!r?.reply) return null;
  return {
    inbound: r.inbound ?? '',
    reply: r.reply,
    // The catalog block is not recoverable per-reply (the ledger keeps product IDs, not the rendered
    // context). Scoring without it is a KNOWN divergence source and is called out in the summary.
    catalog: '',
    businessName: r.business_name ?? undefined,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const threshold = getQualityThreshold();
  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);

  // Collect the inline verdicts the ledger already holds.
  const candidates: Array<{ row: LedgerRow; score: number; wouldFlag: boolean }> = [];
  for await (const row of scanLedger({ tenantId: args.tenantId, since })) {
    const ev = (row.decision_events ?? []).find((e) => e.classifier === 'quality_eval');
    if (!ev || typeof ev.raw_score !== 'number') continue;
    candidates.push({
      row,
      score: ev.raw_score,
      // `passed` records what the eval CONCLUDED (not what was enforced), so this is meaningful in
      // both `enforce` and `shadow` modes — which is exactly what makes a shadow window usable.
      wouldFlag: ev.passed === true,
    });
    if (candidates.length >= args.limit) break;
  }

  if (candidates.length === 0) {
    console.info(
      `[eval:quality] no quality_eval decision events in the last ${args.days} day(s).\n` +
        '  AI_DECISION_LEDGER_ENABLED defaults to false — enable it (with the P1-1 outbox flags) ' +
        'and set QUALITY_EVAL_MODE=shadow to collect the comparison data.',
    );
    return;
  }

  if (args.dryRun) {
    console.info(
      `[eval:quality] DRY RUN — would re-score ${candidates.length} turn(s) from the last ` +
        `${args.days} day(s). Zero OpenAI calls made.`,
    );
    return;
  }

  // Imported lazily, AFTER the dry-run early return: the scorer pulls in `openaiClient`, which
  // throws at module load without an API key. A dry run's whole job is to answer "how much would
  // this cost?" on a machine that has no key configured, so a top-level import would defeat it.
  const { scoreOffline } = await import('./offlineScorer');

  const results: ParityRow[] = [];
  for (const c of candidates) {
    const turn = await loadTurnText(c.row);
    const offline = turn ? await scoreOffline(turn, threshold) : null;
    const offlineScore = offline?.evaluation?.quality_score ?? null;
    results.push({
      idempotencyKey: c.row.idempotency_key,
      conversationId: c.row.conversation_id,
      inlineScore: c.score,
      inlineWouldFlag: c.wouldFlag,
      offlineScore,
      offlineWouldFlag: offline ? offline.wouldFlag : null,
      delta: offlineScore === null ? null : Math.abs(offlineScore - c.score),
    });
  }

  const compared = results.filter((r) => r.delta !== null);
  const deltas = compared.map((r) => r.delta!);
  const meanDelta = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  const maxDelta = deltas.length ? Math.max(...deltas) : 0;
  const disagreements = compared.filter((r) => r.inlineWouldFlag !== r.offlineWouldFlag);

  const summary = {
    since: since.toISOString(),
    threshold,
    ledgerRows: candidates.length,
    compared: compared.length,
    meanAbsDelta: Number(meanDelta.toFixed(4)),
    maxAbsDelta: Number(maxDelta.toFixed(4)),
    flagDisagreements: disagreements.length,
    epsilon: args.epsilon,
    // The acceptance criterion, computed rather than eyeballed.
    parityAchieved: disagreements.length === 0 && maxDelta <= args.epsilon,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.info(`[eval:quality] parity over ${compared.length} turns since ${summary.since}`);
    console.info(`  mean |inline − offline| : ${summary.meanAbsDelta}`);
    console.info(`  max  |inline − offline| : ${summary.maxAbsDelta} (epsilon ${args.epsilon})`);
    console.info(`  flag/would-flag disagreements: ${summary.flagDisagreements}`);
    for (const d of disagreements.slice(0, 10)) {
      console.info(
        `     ↳ conv=${d.conversationId ?? '-'} inline=${d.inlineScore.toFixed(3)}` +
          `(${d.inlineWouldFlag ? 'flag' : 'ok'}) offline=${d.offlineScore?.toFixed(3)}` +
          `(${d.offlineWouldFlag ? 'flag' : 'ok'})`,
      );
    }
    console.info(
      summary.parityAchieved
        ? '\n  PARITY ACHIEVED — QUALITY_EVAL_MODE=off is defensible on this window.'
        : '\n  PARITY NOT ACHIEVED — keep the inline eval until this is clean.',
    );
    console.info(
      '\n  Caveat: the rendered catalog block is not recoverable per-reply (the ledger stores\n' +
        '  product IDs, not the rendered context), so the offline score sees an empty catalog.\n' +
        '  Expect a small systematic delta from that alone; judge the FLAG agreement first.',
    );
  }

  if (!summary.parityAchieved) process.exitCode = 1;
}

// Only runs when invoked directly — importing from this module can never fire a paid batch.
if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[eval:quality] failed', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void pool.end();
    });
}
