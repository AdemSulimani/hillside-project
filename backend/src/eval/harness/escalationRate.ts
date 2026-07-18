/**
 * P3-4 — corpus-level escalation-rate assertions (RC-01).
 *
 * The remediation plan pairs the invariance assertion with "a max-escalation-rate threshold".
 * Two design rules, both aimed at the plan's stated main hazard ("a flaky assertion blocks deploys"):
 *
 * 1. INTEGER ARITHMETIC ONLY. `escalated / total <= 0.1` compares a binary float against a decimal
 *    literal that has no exact binary representation; 1/10 vs 0.1 is the classic way a gate goes red
 *    on one input size and green on another for no behavioural reason. `escalated * 100 <= maxPercent
 *    * total` is exact for integer inputs, which is what these always are.
 *
 * 2. FOR ANSWERABLE CASES, ASSERT ZERO — NOT A RATE. The audit measured 8/8 escalations on two
 *    answerable questions; the post-fix target is 0/N, not "under some percentage". A rate threshold
 *    on the answerable corpus would silently absorb a real regression as long as it stayed under the
 *    bar, AND its denominator would shift every time a case is added — making the gate's strictness
 *    a function of corpus size, which is not a property anyone intends. `assertNoEscalations` is the
 *    right tool there. The rate threshold exists for the ADVERSARIAL-DRAW dimension, where a
 *    non-zero floor is a deliberate tolerance rather than an accident.
 *
 * Pure and leaf: imports nothing.
 */

export interface RateReport {
  total: number;
  hits: number;
  /** Percentage, rounded to 2dp — for humans reading the failure. Never used in the comparison. */
  percent: number;
  /** Identifiers of the cases that counted as a hit, in corpus order. */
  hitIds: string[];
}

/** Build a rate report over labelled cases. `total` is the count, never inferred from `hitIds`. */
export function rateOver<T>(
  cases: readonly T[],
  isHit: (item: T) => boolean,
  idOf: (item: T) => string,
): RateReport {
  const hitIds: string[] = [];
  for (const item of cases) if (isHit(item)) hitIds.push(idOf(item));
  const total = cases.length;
  return {
    total,
    hits: hitIds.length,
    percent: total === 0 ? 0 : Math.round((hitIds.length / total) * 10000) / 100,
    hitIds,
  };
}

/**
 * Exact integer comparison: hits/total <= maxPercent/100.
 *
 * `maxPercent` must be an integer percentage (0–100). A fractional threshold would reintroduce the
 * float comparison this function exists to avoid, so it is rejected rather than silently rounded.
 */
export function rateWithinPercent(report: RateReport, maxPercent: number): boolean {
  if (!Number.isInteger(maxPercent) || maxPercent < 0 || maxPercent > 100) {
    throw new Error(`maxPercent must be an integer 0-100, got ${maxPercent}`);
  }
  if (report.total === 0) return true;
  return report.hits * 100 <= maxPercent * report.total;
}

/** A failure message naming the offending cases, not just the ratio. */
export function describeRate(label: string, report: RateReport, maxPercent?: number): string {
  const bound = maxPercent === undefined ? '' : ` (max ${maxPercent}%)`;
  const ids = report.hitIds.length > 0 ? ` — ${report.hitIds.join(', ')}` : '';
  return `${label}: ${report.hits}/${report.total} = ${report.percent}%${bound}${ids}`;
}

/**
 * The assertion for the answerable corpus: a catalog-answerable question must NEVER escalate.
 * Returns the offending ids so the caller can put them straight into the assertion message.
 */
export function findEscalations<T>(
  cases: readonly T[],
  didEscalate: (item: T) => boolean,
  idOf: (item: T) => string,
): string[] {
  return rateOver(cases, didEscalate, idOf).hitIds;
}
