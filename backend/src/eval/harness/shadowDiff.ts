/**
 * P3-4 — the shadow-diff analyzer: read side (RC-01/02/03, and P3-1's cutover gate).
 *
 * WHY THE ENCODING IS NOT REDESIGNED. P2-2 already ships one live shadow comparison — the
 * deterministic order-stage FSM run beside the legacy gate (`jobs/processAIReply.ts`). It records
 * its verdict into the P1-5 ledger as a `decision_event` whose `branch` is a string:
 *
 *     agree:true:stage=awaiting_confirmation
 *     diverge:legacy=false:det=true:stage=collecting
 *
 * That encoding is already in production ledger rows. Replacing it with structured JSON would
 * orphan every historical row — the exact provenance loss P1-5 exists to prevent — so P3-4 keeps
 * the format byte-for-byte and generalises only the PRODUCER (`services/shadowComparison.ts`) and
 * the READER (this file). `shadowComparison.buildShadowBranch` is pinned by a test asserting it
 * reproduces the strings order_stage emits today.
 *
 * WHAT THIS IS FOR. P3-1 retires ~20 stochastic classifiers, each replaced by a deterministic rule,
 * and the remediation plan makes shadow-diffing the gate: "run a retired classifier and its
 * deterministic replacement side by side on real traffic before cutover". This module turns a pile
 * of ledger rows into the agreement rate that decision is made on.
 *
 * PURE BY DESIGN. `buildShadowDiffReport` takes rows, so it is unit-testable against synthetic
 * input with no DB; the query lives in `eval/runners/shadowReport.ts`. That split is what lets the
 * aggregation logic — the part with the arithmetic — ride the offline CI suite.
 */
import type { LedgerDecisionEvent } from '../../db/models/aiDecisionLedger';

export interface ParsedBranch {
  kind: 'agree' | 'diverge' | 'other';
  /** For `agree:<value>[:k=v…]` — the value both sides produced. */
  value?: string;
  /** For `diverge:legacy=X:det=Y[:k=v…]`. */
  legacy?: string;
  deterministic?: string;
  /** Trailing `k=v` pairs (e.g. `stage=collecting`). */
  context: Record<string, string>;
}

/**
 * Parse one branch string. Unknown shapes return `kind:'other'` rather than throwing — a report
 * over months of ledger rows will meet branch strings written by code that no longer exists, and
 * a crash there would make the analyzer useless exactly when the history matters most.
 */
export function parseShadowBranch(branch: string): ParsedBranch {
  const parts = (branch ?? '').split(':');
  const context: Record<string, string> = {};
  const head = parts[0];

  const readPairs = (from: number): void => {
    for (let i = from; i < parts.length; i++) {
      const eq = parts[i].indexOf('=');
      if (eq > 0) context[parts[i].slice(0, eq)] = parts[i].slice(eq + 1);
    }
  };

  if (head === 'agree') {
    const value = parts[1] !== undefined && !parts[1].includes('=') ? parts[1] : undefined;
    readPairs(value === undefined ? 1 : 2);
    return { kind: 'agree', value, context };
  }

  if (head === 'diverge') {
    let legacy: string | undefined;
    let deterministic: string | undefined;
    for (let i = 1; i < parts.length; i++) {
      if (parts[i].startsWith('legacy=')) legacy = parts[i].slice('legacy='.length);
      else if (parts[i].startsWith('det=')) deterministic = parts[i].slice('det='.length);
    }
    readPairs(1);
    delete context.legacy;
    delete context.det;
    return { kind: 'diverge', legacy, deterministic, context };
  }

  return { kind: 'other', context };
}

/** The minimum a report needs from a ledger row — so tests can build one without the full shape. */
export interface ShadowDiffRow {
  idempotency_key: string;
  conversation_id: string | null;
  created_at: Date | string;
  decision_events: LedgerDecisionEvent[];
}

export interface ShadowDiffReport {
  classifier: string;
  total: number;
  agree: number;
  diverge: number;
  other: number;
  /** Integer percentage, floored. Kept integral so a cutover threshold never rides a float compare. */
  agreementPercent: number;
  /** Agreement broken down by the branch's context pairs (e.g. per order stage). */
  byContext: Array<{ context: string; total: number; diverge: number; agreementPercent: number }>;
  /** A bounded sample of divergences, for the human reading the report. */
  divergenceExamples: Array<{
    idempotencyKey: string;
    conversationId: string | null;
    branch: string;
    createdAt: string;
  }>;
}

/** Render a context map as a single stable key. Keys are SORTED — never Map iteration order. */
function contextKey(context: Record<string, string>): string {
  const keys = Object.keys(context).sort();
  return keys.length === 0 ? '(none)' : keys.map((k) => `${k}=${context[k]}`).join(',');
}

/**
 * Aggregate ledger rows into a per-classifier agreement report.
 *
 * `other`-kind branches are counted but excluded from the agreement denominator: a branch the
 * parser does not recognise is neither agreement nor divergence, and folding it into either would
 * quietly move a cutover threshold.
 */
export function buildShadowDiffReport(
  classifier: string,
  rows: readonly ShadowDiffRow[],
  opts: { maxExamples?: number } = {},
): ShadowDiffReport {
  const maxExamples = opts.maxExamples ?? 10;
  let agree = 0;
  let diverge = 0;
  let other = 0;
  const byContext = new Map<string, { total: number; diverge: number }>();
  const divergenceExamples: ShadowDiffReport['divergenceExamples'] = [];

  for (const row of rows) {
    for (const event of row.decision_events ?? []) {
      if (event.classifier !== classifier) continue;
      const parsed = parseShadowBranch(event.branch);
      if (parsed.kind === 'other') {
        other += 1;
        continue;
      }
      const key = contextKey(parsed.context);
      const bucket = byContext.get(key) ?? { total: 0, diverge: 0 };
      bucket.total += 1;

      if (parsed.kind === 'agree') {
        agree += 1;
      } else {
        diverge += 1;
        bucket.diverge += 1;
        if (divergenceExamples.length < maxExamples) {
          divergenceExamples.push({
            idempotencyKey: row.idempotency_key,
            conversationId: row.conversation_id,
            branch: event.branch,
            createdAt:
              row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
          });
        }
      }
      byContext.set(key, bucket);
    }
  }

  const total = agree + diverge;
  return {
    classifier,
    total,
    agree,
    diverge,
    other,
    agreementPercent: total === 0 ? 100 : Math.floor((agree * 100) / total),
    byContext: [...byContext.entries()]
      .map(([context, v]) => ({
        context,
        total: v.total,
        diverge: v.diverge,
        agreementPercent: v.total === 0 ? 100 : Math.floor(((v.total - v.diverge) * 100) / v.total),
      }))
      // Sorted by key, not insertion order — the report must be diffable run to run.
      .sort((a, b) => (a.context < b.context ? -1 : a.context > b.context ? 1 : 0)),
    divergenceExamples,
  };
}

/**
 * The cutover predicate P3-1 will call: agreement at or above `minPercent` over at least
 * `minRows` observations. Both bounds matter — 100% agreement over 3 rows is not evidence.
 */
export function meetsCutoverBar(
  report: ShadowDiffReport,
  bar: { minPercent: number; minRows: number },
): { pass: boolean; reason: string } {
  if (report.total < bar.minRows) {
    return { pass: false, reason: `only ${report.total} observations (need ${bar.minRows})` };
  }
  if (report.agreementPercent < bar.minPercent) {
    return {
      pass: false,
      reason: `agreement ${report.agreementPercent}% below the ${bar.minPercent}% bar (${report.diverge} divergences)`,
    };
  }
  return { pass: true, reason: `${report.agreementPercent}% over ${report.total} observations` };
}
