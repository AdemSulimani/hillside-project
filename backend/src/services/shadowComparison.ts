/**
 * P3-4 — the generic shadow-comparison recorder (write side).
 *
 * WHAT A SHADOW WINDOW IS FOR. P3-1 retires ~20 stochastic classifiers, each replaced by a
 * deterministic rule, and the remediation plan makes shadow-diffing the gate for every one:
 * "run a retired classifier and its deterministic replacement side by side on real traffic before
 * cutover". The pattern is always the same — compute both, act on one, record whether they agreed —
 * and P2-2 already hand-rolled it once for the order-stage FSM.
 *
 * WHY THE ENCODING IS PRESERVED RATHER THAN IMPROVED. That hand-rolled site writes its verdict into
 * the P1-5 ledger as a `decision_event` whose `branch` is a string:
 *
 *     agree:true:stage=awaiting_confirmation
 *     diverge:legacy=false:det=true:stage=collecting
 *
 * Structured JSON would be a nicer shape, and choosing it would orphan every historical ledger row
 * — the exact provenance loss P1-5 exists to prevent. So this module generalises the PRODUCER and
 * emits byte-identical strings; `shadowComparison.test.ts` pins that against the literal strings
 * order_stage used to build inline. The reader is `eval/harness/shadowDiff.ts`.
 *
 * Pure and leaf: no imports at all. Safe on the send path (which is where it runs).
 */

/** The tri-state every shadow-able decision uses: off | shadow (compute + record) | on (authoritative). */
export type ShadowMode = 'off' | 'shadow' | 'on';

export interface ShadowComparison<T> {
  /** The `decision_events.classifier` value, e.g. 'order_stage'. */
  classifier: string;
  /** What the legacy (usually stochastic) path decided. */
  legacy: T;
  /** What the deterministic replacement decided. */
  deterministic: T;
  /**
   * Extra dimensions to slice agreement by (e.g. `{ stage }`). Rendered as `:k=v` pairs SORTED BY
   * KEY — object insertion order is an iteration-order dependency, and a report that is not
   * diffable run-to-run is much less useful than one that is.
   */
  context?: Record<string, string | number | boolean>;
}

export interface ShadowOutcome {
  agree: boolean;
  /** The `decision_events.branch` string. */
  branch: string;
  /** The deterministic verdict, for `decision_events.passed`. */
  passed: boolean;
}

/** `legacy=`/`det=` are the comparison itself, so they may not be reused as context keys. */
const RESERVED_CONTEXT_KEYS = new Set(['legacy', 'det']);

function renderContext(context: Record<string, string | number | boolean> | undefined): string {
  if (!context) return '';
  const keys = Object.keys(context).sort();
  const parts: string[] = [];
  for (const k of keys) {
    if (RESERVED_CONTEXT_KEYS.has(k)) {
      throw new Error(`shadow context key "${k}" is reserved (it encodes the comparison itself)`);
    }
    parts.push(`:${k}=${String(context[k])}`);
  }
  return parts.join('');
}

/**
 * Build the branch string for one comparison.
 *
 * Reproduces the order-stage encoding exactly:
 *   agree   → `agree:<value><context>`
 *   diverge → `diverge:legacy=<legacy>:det=<deterministic><context>`
 */
export function buildShadowBranch<T>(c: ShadowComparison<T>): ShadowOutcome {
  // `Object.is`, NOT string coercion. Coercing was byte-identical for order_stage (both operands
  // are booleans) but this module is generic and exists for P3-1's ~20 retired classifiers: under
  // coercion `1` and `'1'` would report AGREE, hiding a genuine type divergence between a legacy
  // classifier and its deterministic replacement — the one thing a shadow window is for.
  const agree = Object.is(c.legacy, c.deterministic);
  const ctx = renderContext(c.context);
  return {
    agree,
    // `passed` maps onto `decision_events.passed`, which is a boolean verdict. `Boolean(x)` would
    // report `true` for the string 'false' — i.e. the OPPOSITE of the deterministic verdict — so a
    // non-boolean decision reports `false` rather than a confidently wrong value. Classifiers whose
    // verdict is not boolean should record the outcome in `branch`, which carries the real values.
    passed: c.deterministic === true,
    branch: agree
      ? `agree:${String(c.deterministic)}${ctx}`
      : `diverge:legacy=${String(c.legacy)}:det=${String(c.deterministic)}${ctx}`,
  };
}

/**
 * Which value actually governs, given the mode.
 *
 * `shadow` returns the LEGACY value — that is what makes a shadow window safe to run in production:
 * the new path is exercised and measured on real traffic while changing nothing the customer sees.
 */
export function resolveShadowValue<T>(mode: ShadowMode, legacy: T, deterministic: T): T {
  return mode === 'on' ? deterministic : legacy;
}
