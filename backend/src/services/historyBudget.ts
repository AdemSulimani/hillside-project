/**
 * P2-5 (RC-26): the conversation-history token budget, extracted as a pure function.
 *
 * The eviction loop lived inline in `generateReply` and carried three defects. Extracting it
 * makes them testable (importing aiService pulls in the OpenAI client) and makes the fixed and
 * legacy behaviours explicit side by side rather than hidden in a flag branch:
 *
 *   (b) MISMATCHED ACCOUNTING. The running total was SEEDED with
 *       `formatCustomerMessageContentForPrompt(msg)` for customer rows but DECREMENTED with
 *       `estimateTokens(removed.content)` — the raw content. For any customer message whose
 *       formatted form differs from `content` (attachments, product context, quoted replies) the
 *       total drifted from the thing it claimed to measure, so the loop evicted too many or too
 *       few turns. Modelled below as two arrays: `itemTokens` seeds, `evictionTokens` is
 *       subtracted. Legacy passes the raw-content estimates; the fix passes `itemTokens` itself.
 *
 *   (c) UNEVICTABLE WEIGHT. `olderHistorySummaryTokens` was ADDED to a total the loop can never
 *       reduce — the summary is passed separately to `buildMessagesArray` and is not part of the
 *       evictable window. A large summary therefore permanently inflated the total and could pin
 *       the loop at its 4-message floor while still reporting "over budget", over-truncating real
 *       turns to pay for weight that was never going to move. Fixed by RESERVING it: the
 *       evictable history is budgeted against what remains after the summary.
 *
 * (Defect (a) — the dead `systemPromptTokenEstimate` — is fixed at the aiService call site,
 * where the assembled prompt actually exists.)
 */

export interface HistoryBudgetInput<T> {
  /** The evictable history window, oldest first. */
  items: readonly T[];
  /** Token estimate per item, parallel to `items` — the values that SEED the total. */
  itemTokens: readonly number[];
  /**
   * Token estimate per item to SUBTRACT when that item is evicted, parallel to `items`.
   * Legacy passes raw-content estimates (defect b); the fixed path passes `itemTokens`.
   */
  evictionTokens: readonly number[];
  /** Token estimate for the non-evictable older-history summary. */
  summaryTokens: number;
  /** The history budget. */
  maxTokens: number;
  /**
   * P2-5 fix (c): when true, `summaryTokens` is reserved out of the budget rather than added to
   * the evictable total. When false, the legacy behaviour is reproduced byte-for-byte.
   */
  reserveSummary: boolean;
  /** The loop stops once this many items remain. Legacy floor: `length > 3`. */
  minKeep?: number;
}

export interface HistoryBudgetResult<T> {
  kept: T[];
  /** The running total at the point the loop stopped (semantics differ by `reserveSummary`). */
  total: number;
  evictedCount: number;
  /** The effective budget the total was compared against. */
  budget: number;
}

export function applyHistoryBudget<T>(input: HistoryBudgetInput<T>): HistoryBudgetResult<T> {
  const minKeep = input.minKeep ?? 3;

  const seeded = input.itemTokens.reduce((sum, t) => sum + t, 0);
  let total = input.reserveSummary ? seeded : seeded + input.summaryTokens;
  const budget = input.reserveSummary
    ? Math.max(0, input.maxTokens - input.summaryTokens)
    : input.maxTokens;

  let start = 0;
  while (total > budget && input.items.length - start > minKeep) {
    total -= input.reserveSummary ? input.itemTokens[start] : input.evictionTokens[start];
    start += 1;
  }

  return {
    kept: input.items.slice(start),
    total,
    evictedCount: start,
    budget,
  };
}
