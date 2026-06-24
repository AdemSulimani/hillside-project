/**
 * Cross-turn fact-consistency guard for product information.
 *
 * Problem: an attribute stated in turn N (e.g. "The product costs €25") could be
 * contradicted in turn N+2 (e.g. "The product costs €30") if the product retrieval
 * or the LLM returns a different result on the follow-up question. This is invisible
 * to the per-reply guards (price/attribute guards) because each reply is individually
 * catalog-grounded but they disagree with each other.
 *
 * Approach (conservative and catalog-bounded):
 *  1. Extract stated product prices from recent AI replies in the conversation.
 *  2. If the current reply states a price and a DIFFERENT price was stated for
 *     seemingly the same product in a recent prior turn, flag it as a cross-turn
 *     inconsistency.
 *  3. Only prices are checked — they are unambiguous numeric values. Free-form
 *     attributes (flavor text, descriptions) are not checked here because natural
 *     variation in phrasing is expected and would cause false positives.
 *
 * Pure, import-safe, and fail-open: any error or ambiguity returns no inconsistency.
 * The caller decides whether to escalate; this module only detects.
 */
import type { Message } from '../db/models/message';
import { extractStatedPrices } from './priceConsistencyGuard';

/** Tolerance when comparing two stated prices for equality. */
const PRICE_EPSILON = 0.01;
/** How many recent AI messages to look back across. */
const LOOK_BACK_TURNS = 6;

export interface PriceInconsistency {
  currentPrice: number;
  priorPrice: number;
  priorTurnIndex: number; // 0 = most recent prior AI message
}

/**
 * Return detected price inconsistencies between the current reply and recent AI replies
 * in the conversation. An empty array means no inconsistency was detected.
 *
 * Conservative design:
 *  - Only fires when the current reply states EXACTLY ONE price and a prior AI reply
 *    also states EXACTLY ONE price (multi-price replies reference multiple products
 *    and comparison is ambiguous).
 *  - The prior price must differ from the current price (outside tolerance) to flag.
 *  - Ignores priors where the AI reply text looks like a holding/escalation message
 *    (contains "notify you shortly" / "do t'ju njoftojmë") since those carry no price.
 */
export function detectCrossMessagePriceInconsistency(
  currentReplyText: string,
  recentMessages: Message[],
): PriceInconsistency[] {
  const currentPrices = extractStatedPrices(currentReplyText);
  // Only meaningful for single-price replies.
  if (currentPrices.length !== 1) return [];
  const current = currentPrices[0].value;

  const priorAiReplies = recentMessages
    .filter((m) => m.sent_by === 'ai')
    .slice(-LOOK_BACK_TURNS)
    .reverse(); // most-recent first

  const inconsistencies: PriceInconsistency[] = [];
  for (let i = 0; i < priorAiReplies.length; i++) {
    const msg = priorAiReplies[i];
    const content = (msg.content ?? '').trim();
    if (!content) continue;
    // Skip holding messages.
    if (
      content.toLowerCase().includes('notify you shortly') ||
      content.toLowerCase().includes("t'ju njoftojm")
    )
      continue;
    const priorPrices = extractStatedPrices(content);
    // Only compare single-price prior replies.
    if (priorPrices.length !== 1) continue;
    const prior = priorPrices[0].value;
    if (Math.abs(current - prior) > PRICE_EPSILON) {
      inconsistencies.push({ currentPrice: current, priorPrice: prior, priorTurnIndex: i });
    }
  }
  return inconsistencies;
}
