/**
 * P3-4 — the live-replay aggregator (RC-03). PURE.
 *
 * Separated from `runners/replayRepeat.ts` for the same reason `harness/shadowDiff.ts` is separated
 * from `runners/shadowReport.ts`: the arithmetic that a decision rests on should not be reachable
 * only through a paid, non-deterministic code path. `distinctRepliesPerInput` is the number the
 * audit used to prove reply generation is stochastic ([1, 3, 8] across three fixed inputs) — it
 * deserves offline tests, and the runner that calls the model cannot have them.
 *
 * Pure: imports only the token-membership checker and the price-set builder, neither of which
 * reaches `openaiClient`. Runs in `npm test` with no DB, Redis, network or OpenAI key.
 */
import { buildPriceSetFromCatalogRows } from '../../services/catalogGuardReferenceService';
import { checkClaimTokenMembership } from './tokenMembership';

/** Normalize a reply for distinctness counting: whitespace and case only — never semantics. */
function normalizeReply(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface ReplayCaseResult {
  id: string;
  text: string;
  runs: number;
  /** RC-03's measurement. 1 means stable wording; the audit measured up to 8. */
  distinctReplies: number;
  /** Distinct replies, capped for readability, in first-seen order. */
  samples: string[];
  /** How many RUNS produced an ungrounded product-claim token (not how many tokens). */
  fabricationViolations: number;
  /** Every distinct fabricated span seen across the runs, sorted for diffability. */
  fabricatedSpans: string[];
}

export interface ReplaySummaryInput {
  id: string;
  text: string;
  replies: readonly string[];
  injectedCatalogText: string;
  catalogNames: readonly string[];
  catalogPriceRows: ReadonlyArray<{ price: string; discounted_price: string | null }>;
}

/**
 * Aggregate N replies for one fixed input.
 *
 * Divergence and fabrication are reported INDEPENDENTLY, because they are independent failures: the
 * audit's 8-way-divergent input happened to also be the fabricating one, but a reply can be
 * perfectly stable and wrong on every single run.
 */
export function summarizeReplays(input: ReplaySummaryInput): ReplayCaseResult {
  const distinct = new Map<string, string>();
  for (const r of input.replies) {
    const key = normalizeReply(r);
    if (!distinct.has(key)) distinct.set(key, r);
  }

  const priceSet = buildPriceSetFromCatalogRows([...input.catalogPriceRows]);
  const spans = new Set<string>();
  let violations = 0;
  for (const reply of input.replies) {
    const result = checkClaimTokenMembership({
      replyText: reply,
      injectedCatalogText: input.injectedCatalogText,
      catalogNameIndex: input.catalogNames,
      priceSet,
      customerText: input.text,
    });
    if (!result.ok) {
      violations += 1;
      for (const v of result.violations) spans.add(v.span);
    }
  }

  return {
    id: input.id,
    text: input.text,
    runs: input.replies.length,
    distinctReplies: distinct.size,
    samples: [...distinct.values()].slice(0, 4),
    fabricationViolations: violations,
    fabricatedSpans: [...spans].sort(),
  };
}
