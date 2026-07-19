/**
 * P3-6 — the model-tier downgrade gate. `npm run eval:tier`
 *
 * ⚠️ PAID and STOCHASTIC: it calls OpenAI twice per case (baseline arm + candidate arm), and with
 * `--runs>1` it calls the candidate repeatedly to measure determinism. NEVER in CI. `--dry-run` is
 * the DEFAULT — it reports what WOULD run and makes zero API calls, following `replayRepeat.ts`
 * rather than `parityReport.ts`, because this runner's cost scales with corpus size × runs.
 *
 * WHAT IT ANSWERS. P2-7 already gave every call site a per-role model var, so
 * `OPENAI_CLASSIFIER_MODEL=gpt-4o-mini` re-routes the entire ~20-call fan-out with no code change.
 * The knob was never the missing piece — the EVIDENCE was. This runner produces it: per-corpus
 * agreement between the two models, regressions against known-correct answers, a determinism
 * check, and the measured cost delta, with a non-zero exit when the bar is unmet.
 *
 * THE BAR IS ASYMMETRIC ON PURPOSE. Agreement is a percentage you can trade against a cost
 * saving; a fabrication regression or answering a true knowledge gap is not. Those corpora are
 * zero-tolerance. And a candidate that answers the same input differently across identical runs
 * fails outright regardless of its scores — that is RC-03's mechanism, and no price makes it
 * acceptable in a pipeline whose every downstream guard judges the text it is given.
 *
 *   npx tsx src/eval/runners/tierDowngrade.ts --role=classifier --candidate=gpt-4o-mini
 *   npx tsx src/eval/runners/tierDowngrade.ts --role=classifier --candidate=gpt-4o-mini --live
 *   npx tsx src/eval/runners/tierDowngrade.ts --role=classifier --candidate=gpt-4o-mini --live --runs=3 --json
 *
 * Suggested downgrade order, cheapest-risk first: `eval` (a scoring call, not customer prose) →
 * `intent` → `classifier` → `chat` last and probably never.
 */
import { GHEG_CORPUS } from '../ghegFluency/corpus';
import { GOLDEN_ANSWERABLE, GOLDEN_TRUE_GAPS } from '../corpora/goldenGapGate';
import {
  buildTierReport,
  meetsTierBar,
  renderDecision,
  type TierCase,
} from '../harness/tierComparison';

interface Args {
  role: string;
  candidate: string;
  baseline?: string;
  runs: number;
  live: boolean;
  json: boolean;
  minPercent: number;
  minRows: number;
  limit: number;
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
  const role = get('role');
  const candidate = get('candidate');
  if (!role) throw new Error('--role is required (chat|classifier|vision|eval|intent|product_processing)');
  if (!candidate) throw new Error('--candidate is required (the cheaper model id to evaluate)');
  return {
    role,
    candidate,
    baseline: get('baseline'),
    runs: num('runs', 1),
    // Dry-run is the DEFAULT. This runner's cost is corpus x runs x 2 arms, which is exactly the
    // shape that produces a surprise invoice when someone runs it to "see what it does".
    live: argv.includes('--live'),
    json: argv.includes('--json'),
    minPercent: num('min-percent', 98),
    minRows: num('min-rows', 20),
    limit: num('limit', 500),
  };
}

/**
 * The corpora a downgrade is judged on, and why each is here.
 *
 * The Gheg corpus is NON-NEGOTIABLE: the item's own stated edge case is "a cheap model that
 * regresses Gheg", and this platform's primary market is Albanian-speaking. A model that scores
 * well on the English-shaped corpora and loses Gheg locale detection is a correctness regression
 * wearing a cost win's clothes.
 */
interface CorpusProbe {
  corpus: string;
  id: string;
  /** The classification question posed to both arms. */
  prompt: string;
  /** The known-correct answer, when the corpus has one. */
  expected?: unknown;
}

function buildProbes(limit: number): CorpusProbe[] {
  const probes: CorpusProbe[] = [];

  for (const [i, c] of GHEG_CORPUS.entries()) {
    probes.push({
      corpus: 'gheg',
      id: `GH-${String(i + 1).padStart(2, '0')}`,
      prompt:
        'Reply with a single JSON object {"locale":"sq"|"en"} naming the language this customer ' +
        `message is written in. Message: ${JSON.stringify(c.text)}`,
      expected: { locale: c.expectLocale },
    });
  }

  for (const c of GOLDEN_ANSWERABLE) {
    probes.push({
      corpus: 'gap_gate_answerable',
      id: c.id,
      prompt:
        'A customer asked about a product. Given the catalog rows, reply with a single JSON ' +
        'object {"answerable":true|false} — true when the rows contain enough information to ' +
        `answer. Question: ${JSON.stringify(c.text)}. Rows: ${JSON.stringify(c.products)}`,
      expected: { answerable: true },
    });
  }

  for (const c of GOLDEN_TRUE_GAPS) {
    probes.push({
      corpus: 'gap_gate_true_gaps',
      id: c.id,
      prompt:
        'A customer asked about a product. Given the catalog rows, reply with a single JSON ' +
        'object {"answerable":true|false} — true when the rows contain enough information to ' +
        `answer. Question: ${JSON.stringify(c.text)}. Rows: ${JSON.stringify(c.products)}`,
      expected: { answerable: false },
    });
  }

  return probes.slice(0, limit);
}

async function runArm(model: string, probes: CorpusProbe[]): Promise<Map<string, unknown>> {
  // Imported lazily and only on the live path: a static import of `openaiClient` would make this
  // module un-importable without an API key (it throws at module load), and the offline fence
  // asserts no CI-side eval module can reach it.
  const { openai } = await import('../../services/openaiClient');
  const out = new Map<string, unknown>();
  for (const probe of probes) {
    try {
      const completion = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: probe.prompt }],
        // Temperature 0 on both arms: this measures the MODEL's decision, not sampling noise.
        temperature: 0,
        max_tokens: 64,
        response_format: { type: 'json_object' },
      });
      const raw = completion.choices[0]?.message?.content ?? '{}';
      out.set(probe.id, JSON.parse(raw));
    } catch (err) {
      // A failed probe records an explicit error marker rather than being dropped: silently
      // shrinking the sample would raise the agreement percentage of whatever survived.
      out.set(probe.id, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { resolveModel } = await import('../../config/models');
  const baselineModel =
    args.baseline ?? resolveModel(args.role as Parameters<typeof resolveModel>[0]);
  const probes = buildProbes(args.limit);

  if (!args.live) {
    console.info(
      `[eval:tier] DRY RUN — no OpenAI calls made.\n` +
        `  role:      ${args.role}\n` +
        `  baseline:  ${baselineModel}\n` +
        `  candidate: ${args.candidate}\n` +
        `  probes:    ${probes.length} across ${new Set(probes.map((p) => p.corpus)).size} corpora\n` +
        `  runs:      ${args.runs} (candidate arm)\n` +
        `  calls:     ${probes.length * (1 + args.runs)} OpenAI calls if run with --live\n` +
        `\nRe-run with --live to execute.`,
    );
    return;
  }

  const { runWithOpenAICallTracking, getTrackedOpenAICalls } = await import(
    '../../services/openaiCallTracker'
  );

  const sumUsd = (calls: ReturnType<typeof getTrackedOpenAICalls>): number | null => {
    if (!calls) return null;
    const priced = calls.map((c) => c.usd_cost).filter((c): c is number => typeof c === 'number');
    return priced.length > 0 ? priced.reduce((s, c) => s + c, 0) : null;
  };

  // The runner prices its own A/B with the very machinery this item ships.
  let baselineUsd: number | null = null;
  const baseline = await runWithOpenAICallTracking(async () => {
    const r = await runArm(baselineModel, probes);
    baselineUsd = sumUsd(getTrackedOpenAICalls());
    return r;
  });

  let candidateUsd: number | null = null;
  const candidateRuns: Array<Map<string, unknown>> = [];
  for (let i = 0; i < Math.max(1, args.runs); i++) {
    // eslint-disable-next-line no-await-in-loop
    const run = await runWithOpenAICallTracking(async () => {
      const r = await runArm(args.candidate, probes);
      const usd = sumUsd(getTrackedOpenAICalls());
      if (usd !== null) candidateUsd = (candidateUsd ?? 0) + usd;
      return r;
    });
    candidateRuns.push(run);
  }

  // Determinism: how many DISTINCT decision vectors the candidate produced across runs. >1 fails
  // the bar outright — see `meetsTierBar`.
  const vectors = new Set(
    candidateRuns.map((run) => probes.map((p) => renderDecision(run.get(p.id))).join('|')),
  );

  const cases: TierCase[] = probes.map((p) => ({
    id: p.id,
    corpus: p.corpus,
    baseline: baseline.get(p.id),
    candidate: candidateRuns[0].get(p.id),
    expected: p.expected,
  }));

  const report = buildTierReport({
    role: args.role,
    baselineModel,
    candidateModel: args.candidate,
    cases,
    candidateDistinctRuns: vectors.size,
    baselineUsd,
    // Average across runs so the comparison is one arm vs one arm.
    candidateUsd: candidateUsd !== null ? candidateUsd / Math.max(1, args.runs) : null,
  });

  const verdict = meetsTierBar(report, {
    minPercent: args.minPercent,
    minRows: args.minRows,
    // Answering a TRUE knowledge gap is a fabrication, and the error is asymmetric: a wrong
    // "yes, we have that" reaches a customer, while a wrong escalation reaches a human.
    zeroRegressionCorpora: ['gap_gate_true_gaps'],
  });

  if (args.json) {
    console.log(JSON.stringify({ report, verdict }, null, 2));
  } else {
    console.info(
      `\n[eval:tier] ${args.role}: ${baselineModel} -> ${args.candidate}\n` +
        `  overall: ${report.agreementPercent}% agreement over ${report.total} cases ` +
        `(${report.regressions} regression(s))`,
    );
    for (const c of report.corpora) {
      console.info(
        `    ${c.corpus.padEnd(22)} ${String(c.agreementPercent).padStart(3)}%  ` +
          `(${c.disagree}/${c.total} disagreed, ${c.regressions} regressions, ${c.improvements} improvements)`,
      );
      for (const ex of c.disagreementExamples) {
        console.info(`        ${ex.id}: baseline=${ex.baseline} candidate=${ex.candidate}`);
      }
    }
    console.info(
      `  determinism: ${report.candidateDistinctRuns} distinct decision vector(s) across ${args.runs} run(s)`,
    );
    const { baselineUsd: b, candidateUsd: cnd, savingRatio } = report.cost;
    console.info(
      `  cost: baseline $${b?.toFixed(6) ?? '?'} vs candidate $${cnd?.toFixed(6) ?? '?'}` +
        (savingRatio !== null ? ` (${Math.round(savingRatio * 100)}% cheaper)` : ''),
    );
    console.info(`\n  VERDICT: ${verdict.pass ? 'PASS' : 'FAIL'} — ${verdict.reason}\n`);
  }

  if (!verdict.pass) process.exitCode = 1;
}

// Guarded so importing this module can never fire a paid batch. The offline fence asserts the
// guard exists and that no CI-side module reaches this file.
if (require.main === module) {
  main().catch((err) => {
    console.error('[eval:tier] failed', err);
    process.exitCode = 1;
  });
}
