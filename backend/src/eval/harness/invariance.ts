/**
 * P3-4 — the decision-invariance comparator (RC-01, RC-03).
 *
 * WHAT THIS ACTUALLY MEASURES, AND WHY THE NAME MATTERS.
 *
 * The remediation plan calls for "golden determinism corpora … each N≥20× with hard determinism
 * assertions". Taken literally that is VACUOUS here: every decision function this harness gates is
 * a pure total function, so calling it 20 times with identical arguments proves nothing but that
 * JavaScript is deterministic. A future reader who believes the label is free to "simplify" such a
 * suite into exactly that vacuous loop, and it will stay green while guarding nothing.
 *
 * What the audit actually measured is a different property. RC-01's live replay ran the assessor
 * eight times on ONE fixed input and got eight results — IN1 escalated 8/8 with `missing=['marka']`
 * though brand was never asked; IN3 escalated 8/8 with the escalation REASON itself varying at
 * temperature 0 (4×`['cila eshte me e mire']`, 4×`['më e mirë']`). The input was constant; the
 * stochastic sub-decision was not. So the property worth asserting is:
 *
 *     INVARIANCE — for a fixed customer input, the pipeline's DISCRETE OUTCOME must be identical
 *     no matter what the stochastic sub-decision happens to emit on this run.
 *
 * That is why `perturb` draws a NEW adversarial sub-decision on every run rather than replaying one.
 * The N runs are N different stochastic draws, not N repetitions. A gate that reaches its verdict
 * from deterministic evidence passes; a gate that forwards the LLM's opinion (the pre-P0-3 policy)
 * fails — which is precisely what the meta-tests assert it does.
 *
 * DETERMINISM OF THE HARNESS ITSELF is a separate, real requirement: the remediation plan makes
 * this a release gate ("a flaky assertion blocks deploys") and demands the golden set run 3× in CI
 * with identical pass/fail. That is satisfied BY CONSTRUCTION, not by luck: `makeSeededRng` is a
 * pure LCG re-seeded at the start of every replay, so the N draws are byte-identical on every
 * machine and every run. Nothing here reads the clock, `Math.random`, the environment, or Set
 * iteration order.
 *
 * Pure and leaf: imports nothing. Runs in `npm test` with no DB, Redis, network or OpenAI key.
 */

/** A pure pseudo-random source. Seeded, reproducible, and the only randomness allowed under src/eval. */
export type Rng = () => number;

/**
 * Numerical Recipes LCG. Chosen over `Math.random` because a release gate must produce the same
 * draws on every machine forever, and over a crypto hash because it needs no imports and its
 * output is trivially reproducible by hand when a failure has to be debugged.
 */
export function makeSeededRng(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Draw an integer in [0, max). */
export function rngInt(rng: Rng, max: number): number {
  return Math.floor(rng() * max) % Math.max(1, max);
}

/**
 * Pick one element.
 *
 * Throws on an empty list rather than returning `undefined` behind a `T` annotation. A corpus that
 * silently drew `undefined` labels would still produce a green invariance sweep — the decision
 * would be stable because nothing was ever perturbed — which is the exact shape of a gate that has
 * stopped guarding.
 */
export function rngPick<T>(rng: Rng, items: readonly T[]): T {
  if (items.length === 0) throw new Error('rngPick: empty list — the perturbation source is empty');
  return items[rngInt(rng, items.length)];
}

/**
 * Order-insensitive, stable stringification used to compare outcomes.
 *
 * Object key order is an iteration-order dependency, and iteration order is exactly the class of
 * hazard that makes a release gate flake on one machine and not another. Sorting keys removes it.
 * Arrays keep their order — for a decision outcome, element order IS meaningful.
 */
export function stableKey(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v === undefined ? '__undefined__' : v;
    if (seen.has(v as object)) return '__cycle__';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = walk((v as Record<string, unknown>)[k]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

export interface InvarianceReport<D> {
  /** How many adversarial draws were replayed. */
  runs: number;
  /** The outcome of each run, in run order. */
  outcomes: D[];
  /** Distinct outcome keys, in first-seen order. Length 1 ⇒ invariant. */
  distinct: string[];
  /** True when every run produced the same outcome. */
  stable: boolean;
  /** 1-based index of the first run that differed from run 1, or null when stable. */
  firstDivergenceRun: number | null;
}

/**
 * Replay one fixed input through `decide` N times, drawing a fresh adversarial stochastic
 * sub-decision each run, and report whether the outcome ever moved.
 *
 * `seed` is explicit rather than defaulted so a corpus can give each case its own draw sequence —
 * three cases sharing one seed would replay three identical perturbation streams and silently
 * narrow coverage to a third of what the run count suggests.
 */
export function replayUnderPerturbation<P, D>(input: {
  runs: number;
  seed: number;
  perturb: (rng: Rng, run: number) => P;
  decide: (perturbation: P, run: number) => D;
  /** Override how two outcomes are compared. Defaults to `stableKey`. */
  key?: (outcome: D) => string;
}): InvarianceReport<D> {
  const key = input.key ?? ((o: D) => stableKey(o));
  const rng = makeSeededRng(input.seed);
  const outcomes: D[] = [];
  const distinct: string[] = [];
  let firstDivergenceRun: number | null = null;

  for (let run = 0; run < input.runs; run++) {
    const outcome = input.decide(input.perturb(rng, run), run);
    outcomes.push(outcome);
    const k = key(outcome);
    if (!distinct.includes(k)) distinct.push(k);
    if (firstDivergenceRun === null && distinct.length > 1) firstDivergenceRun = run + 1;
  }

  return {
    runs: input.runs,
    outcomes,
    distinct,
    stable: distinct.length <= 1,
    firstDivergenceRun,
  };
}

/**
 * A failure message that names the actual divergence rather than "expected true, got false".
 * A release gate is read by whoever it blocked, usually in a hurry.
 */
export function describeInvariance<D>(label: string, report: InvarianceReport<D>): string {
  if (report.stable) return `${label}: stable across ${report.runs} draws`;
  const shown = report.distinct.slice(0, 4).map((d, i) => `  [${i + 1}] ${d}`).join('\n');
  return (
    `${label}: outcome CHANGED across ${report.runs} adversarial draws ` +
    `(first divergence at run ${report.firstDivergenceRun}, ${report.distinct.length} distinct):\n${shown}` +
    (report.distinct.length > 4 ? `\n  …and ${report.distinct.length - 4} more` : '')
  );
}

/** Count the runs whose outcome satisfies `predicate` (e.g. "escalated"). */
export function countMatching<D>(report: InvarianceReport<D>, predicate: (outcome: D) => boolean): number {
  let n = 0;
  for (const o of report.outcomes) if (predicate(o)) n += 1;
  return n;
}
