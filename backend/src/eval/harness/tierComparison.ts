/**
 * P3-6 — the tier-downgrade comparator: does a cheaper model decide the same things?
 *
 * PURE and CI-blocking. No clock, no `Math.random`, no OpenAI import — the fence in
 * `goldenSets/__tests__/harnessOfflineFence.test.ts` enforces all three, and the split mirrors
 * `shadowDiff.ts` (pure analyzer) / `shadowReport.ts` (the runner that fetches the data). The
 * arithmetic that decides whether a downgrade ships must not be reachable only through a paid
 * API call.
 *
 * WHY A DEDICATED COMPARATOR RATHER THAN REUSING `shadowDiff`. `shadowDiff` reads shadow branches
 * out of the LEDGER, which requires the live send path to emit them — and `recordDecision` is a
 * local closure inside `processAIReply`, unreachable from the ~25 classifiers in `aiService.ts`
 * that a tier decision is actually about. Threading a sink through that file for a measurement is
 * the wrong trade, so the tier gate compares two arms offline over a corpus instead. The bar
 * predicate below deliberately keeps `meetsCutoverBar`'s shape (percent + a minimum sample) so
 * the two gates read the same way.
 */

export interface TierCase {
  /** Stable case id from the corpus (e.g. 'IN1', 'GH-07'). */
  id: string;
  /** The baseline (full-model) decision. */
  baseline: unknown;
  /** The candidate (cheap-model) decision. */
  candidate: unknown;
  /**
   * Which corpus this case belongs to. Bars are applied per corpus, because a fabrication
   * regression and a locale regression are not interchangeable.
   */
  corpus: string;
  /**
   * Set when the case has a KNOWN-CORRECT answer (the golden corpora do; a free-prose reply does
   * not). Lets the report distinguish "the candidate disagreed" from "the candidate was wrong".
   */
  expected?: unknown;
}

export interface TierCorpusReport {
  corpus: string;
  total: number;
  agree: number;
  disagree: number;
  agreementPercent: number;
  /** Cases where the baseline was right and the candidate was wrong — a genuine regression. */
  regressions: number;
  /** Cases where the candidate was right and the baseline was wrong. Reported, never a licence. */
  improvements: number;
  disagreementExamples: Array<{ id: string; baseline: string; candidate: string }>;
}

export interface TierReport {
  role: string;
  baselineModel: string;
  candidateModel: string;
  corpora: TierCorpusReport[];
  total: number;
  agree: number;
  agreementPercent: number;
  regressions: number;
  /** Determinism: distinct decision vectors the candidate produced across repeated runs. */
  candidateDistinctRuns: number;
  cost: { baselineUsd: number | null; candidateUsd: number | null; savingRatio: number | null };
}

/**
 * Stable, order-independent rendering so two structurally equal decisions compare equal.
 *
 * Strings are QUOTED, so `1` and `'1'` do not render alike. This is the same trap
 * `shadowComparison.buildShadowBranch` documents avoiding with `Object.is` rather than string
 * coercion: under coercion a model returning `"true"` and one returning `true` would report
 * AGREE, hiding a genuine type divergence — and hiding divergence is the one thing a comparison
 * gate must never do.
 */
export function renderDecision(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v !== 'object') return String(v);
  if (Array.isArray(v)) return `[${v.map(renderDecision).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    // Plain `sort()` on ASCII keys, NOT localeCompare — banned under src/eval/** because a
    // locale-dependent ordering makes a release gate machine-dependent.
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, val]) => `${k}=${renderDecision(val)}`);
  return `{${entries.join(',')}}`;
}

const agrees = (a: unknown, b: unknown): boolean => renderDecision(a) === renderDecision(b);

export function buildTierReport(args: {
  role: string;
  baselineModel: string;
  candidateModel: string;
  cases: TierCase[];
  candidateDistinctRuns?: number;
  baselineUsd?: number | null;
  candidateUsd?: number | null;
  maxExamples?: number;
}): TierReport {
  const maxExamples = args.maxExamples ?? 5;
  const byCorpus = new Map<string, TierCase[]>();
  for (const c of args.cases) {
    const list = byCorpus.get(c.corpus) ?? [];
    list.push(c);
    byCorpus.set(c.corpus, list);
  }

  const corpora: TierCorpusReport[] = [...byCorpus.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([corpus, cases]) => {
      let agree = 0;
      let regressions = 0;
      let improvements = 0;
      const examples: TierCorpusReport['disagreementExamples'] = [];
      for (const c of cases) {
        if (agrees(c.baseline, c.candidate)) {
          agree += 1;
          continue;
        }
        if (examples.length < maxExamples) {
          examples.push({
            id: c.id,
            baseline: renderDecision(c.baseline),
            candidate: renderDecision(c.candidate),
          });
        }
        if (c.expected !== undefined) {
          const baselineRight = agrees(c.baseline, c.expected);
          const candidateRight = agrees(c.candidate, c.expected);
          if (baselineRight && !candidateRight) regressions += 1;
          if (!baselineRight && candidateRight) improvements += 1;
        }
      }
      return {
        corpus,
        total: cases.length,
        agree,
        disagree: cases.length - agree,
        // Floored, matching `shadowDiff.buildShadowDiffReport` — a bar of "99%" must not be
        // cleared by 98.6% rounding up.
        agreementPercent: cases.length > 0 ? Math.floor((agree / cases.length) * 100) : 0,
        regressions,
        improvements,
        disagreementExamples: examples,
      };
    });

  const total = args.cases.length;
  const agree = corpora.reduce((s, c) => s + c.agree, 0);
  const regressions = corpora.reduce((s, c) => s + c.regressions, 0);

  const baselineUsd = args.baselineUsd ?? null;
  const candidateUsd = args.candidateUsd ?? null;
  const savingRatio =
    baselineUsd !== null && candidateUsd !== null && baselineUsd > 0
      ? Math.round((1 - candidateUsd / baselineUsd) * 1000) / 1000
      : null;

  return {
    role: args.role,
    baselineModel: args.baselineModel,
    candidateModel: args.candidateModel,
    corpora,
    total,
    agree,
    agreementPercent: total > 0 ? Math.floor((agree / total) * 100) : 0,
    regressions,
    candidateDistinctRuns: args.candidateDistinctRuns ?? 1,
    cost: { baselineUsd, candidateUsd, savingRatio },
  };
}

export interface TierBar {
  minPercent: number;
  minRows: number;
  /** Corpora on which ANY regression fails the gate outright. */
  zeroRegressionCorpora?: string[];
}

/**
 * Does this report clear the downgrade bar?
 *
 * Four hard gates, and the asymmetry between them is the point:
 *  - a minimum SAMPLE, because 100% agreement over 3 cases is not evidence (the same reasoning
 *    `meetsCutoverBar` records);
 *  - an agreement floor;
 *  - ZERO regressions on the named corpora — fabrication and true-gap answering are correctness
 *    failures, not a percentage to trade against a cost saving;
 *  - DETERMINISM: a candidate that produces different decision vectors across identical repeated
 *    runs is not downgradeable at any price, because every downstream guard would judge each run
 *    differently (RC-03's whole mechanism).
 */
export function meetsTierBar(report: TierReport, bar: TierBar): { pass: boolean; reason: string } {
  if (report.total < bar.minRows) {
    return { pass: false, reason: `only ${report.total} cases (need >= ${bar.minRows})` };
  }
  if (report.candidateDistinctRuns > 1) {
    return {
      pass: false,
      reason: `candidate is NON-DETERMINISTIC: ${report.candidateDistinctRuns} distinct decision vectors across runs`,
    };
  }
  for (const corpus of bar.zeroRegressionCorpora ?? []) {
    const c = report.corpora.find((x) => x.corpus === corpus);
    if (c && c.regressions > 0) {
      return { pass: false, reason: `${c.regressions} regression(s) on the ${corpus} corpus (must be 0)` };
    }
  }
  if (report.agreementPercent < bar.minPercent) {
    return {
      pass: false,
      reason: `agreement ${report.agreementPercent}% < ${bar.minPercent}%`,
    };
  }
  return { pass: true, reason: `${report.agreementPercent}% agreement over ${report.total} cases` };
}
