/**
 * UNCERTAIN-ANSWER FALLBACK GUARD (additive safety layer).
 *
 * Purpose
 * ───────
 * The business never wants the AI to send an unprofessional "we don't have that"
 * / "we don't have information about that" / "I'm not sure" style deflection to a
 * customer. Those replies make the business look unprepared and risk lost sales.
 * They are also the visible symptom of the AI lacking the information or the
 * confidence to answer reliably — exactly the cases that should be handed to a
 * human instead of guessed at.
 *
 * This module is the LAST line of defence, run on the fully-composed outbound
 * reply right before it is sent. When the reply is a generic
 * knowledge/uncertainty deflection (and no earlier escalation already handled the
 * turn) the caller replaces it with a polite holding message
 * ("Hello, we will get back to you shortly with an answer.") and escalates the
 * conversation to a human (pause AI + create alert + flag for review).
 *
 * Design constraints (must not change existing behaviour):
 *  - PURE and dependency-free → fully unit-testable in-process, mirroring
 *    priceConsistencyGuard.ts / productInformationGapHelpers.ts.
 *  - HIGH PRECISION → it only matches unmistakable deflection/uncertainty wording
 *    so grounded, helpful, order-flow, and closing replies are never touched.
 *  - It performs NO I/O and makes NO escalation decision side-effects; it only
 *    detects and recommends. The caller owns the escalation transaction.
 *  - It is GATED by the caller behind a feature flag so it can be disabled without
 *    code changes if a tenant ever wants the raw AI behaviour back.
 *
 * Coverage split with the existing system:
 *  - "We don't have that product / it's not available" (negative AVAILABILITY) is
 *    already detected upstream by aiService.classifyNegativeAvailabilityReply; the
 *    caller passes that result in as `negativeAvailabilityDetected`.
 *  - This module adds deterministic detection of negative-KNOWLEDGE and
 *    UNCERTAINTY deflections ("we don't have information about that", "I'm not
 *    sure", "I don't know", "I can't answer that") in English and Albanian, which
 *    the availability classifier intentionally does not cover.
 */

/** Locales supported by the holding copy (matches aiService ReplyLocale). */
export type UncertainAnswerLocale = 'sq' | 'en';

/**
 * The polite holding message sent in place of an uncertain deflection. It never
 * states that a product/policy is unavailable — it simply promises a follow-up so
 * a human can provide the correct, reliable answer.
 */
export const GET_BACK_TO_YOU_MESSAGES: Record<UncertainAnswerLocale, string> = {
  en: 'Hello, we will get back to you shortly with an answer.',
  sq: 'Përshëndetje, do t’ju kthehemi së shpejti me një përgjigje.',
};

/** The dedicated alert reason used for this escalation. */
export const UNCERTAIN_ANSWER_ALERT_REASON = 'uncertain_answer_escalated';

/**
 * Normalize free reply text for deterministic phrase matching:
 *  - lowercase
 *  - strip diacritics (Albanian ë, ç, …)
 *  - normalize curly/typographic apostrophes to a straight space-friendly form
 *  - collapse punctuation and whitespace to single spaces
 *
 * After this, "Nuk e dimë." and "nuk e dime" both become "nuk e dime", and
 * "I'm not sure" / "I’m not sure" both become "i m not sure".
 */
function normalize(text: string): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’'`]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * High-precision deflection / uncertainty patterns, applied to NORMALIZED text.
 *
 * These intentionally target negative-KNOWLEDGE and UNCERTAINTY wording only.
 * They deliberately do NOT match:
 *  - grounded answers ("the price is 25 euro"),
 *  - order-flow requests ("please share your name and address"),
 *  - closing pleasantries ("no problem, take care"),
 *  - the canned out-of-stock reply (handled separately by the caller).
 */
const DEFLECTION_PATTERNS: RegExp[] = [
  // ---- English: negative knowledge -------------------------------------------
  // "we don't have (any) information/details about that", "I do not have that info"
  /\b(we|i) (do not|dont|don t|do nt) have (any |that |this |the )*(information|info|infos|details|data|answer|answers)\b/,
  // "we don't have access to that (information)"
  /\b(we|i) (do not|dont|don t|do nt) have access to\b/,
  // "no information about/on/regarding ..."
  /\b(no|not any|dont have any|do not have any) (information|info|details|data) (about|on|regarding|for|concerning)\b/,
  // "that information is not available", "this is not available to us"
  /\b(information|info|details|data|that|this|it) (is|s) not available\b/,
  // "we don't have access" / "we can't access that"
  /\b(we|i) (can not|cannot|cant|can t) access\b/,

  // ---- English: uncertainty --------------------------------------------------
  // "I don't know", "we do not know"
  /\b(i|we) (do not|dont|don t|do nt) know\b/,
  // "I'm not sure", "I am not certain", "we're not sure"
  /\b(i|we) (am|m|are|re) not (sure|certain)\b/,
  // "not sure about that"
  /\bnot sure about (that|this|it)\b/,
  // "I can't / cannot / am unable to answer/help/assist with that"
  /\b(i|we) (can not|cannot|cant|can t|am unable to|are unable to|m unable to|m not able to|are not able to) (answer|help|assist|tell)\b/,
  // "unfortunately we/I do not / cannot ..."
  /\bunfortunately,? (we|i) (do not|dont|don t|cannot|can not|cant|can t)\b/,

  // ---- Albanian: negative knowledge ------------------------------------------
  // "nuk kemi/kam informacion" — we/I don't have information
  /\bnuk (kemi|kam|kemi asnje|kam asnje) (informacion|info|te dhena|detaje|pergjigje)\b/,
  // "nuk ka informacion" — there is no information
  /\bnuk ka (informacion|info|te dhena|detaje)\b/,
  // "nuk kemi akses" — we don't have access
  /\bnuk (kemi|kam) akses\b/,
  // "kete informacion nuk e kemi/dim" — we don't have this information
  /\b(kete|ate) (informacion|info|te dhene) nuk e (kemi|kam|dim|dime)\b/,

  // ---- Albanian: uncertainty -------------------------------------------------
  // "nuk e di", "nuk e dime", "nuk e dim" — I/we don't know
  /\bnuk e (di|dim|dime|dijme)\b/,
  // "nuk jam i/e sigurt", "nuk jemi te sigurt" — I'm/we're not sure
  /\bnuk (jam|jemi) (i |e |te )?sigurt\b/,
  // "nuk mund t'ju pergjigjem / ndihmoj" — I can't answer/help you
  /\bnuk mund (t ju|t i|te) (pergjigjem|ndihmoj|ndihmojme|pergjigjemi)\b/,
  // "s'e di", "s'e dime" — colloquial "don't know"
  /\bs e (di|dim|dime)\b/,
];

/**
 * OUT-OF-STOCK phrasing, applied to NORMALIZED text.
 *
 * An out-of-stock reply is legitimate, reliable information (the product exists,
 * it simply has no stock right now) and the business wants it delivered to the
 * customer as-is — NOT escalated. These patterns are keyed on explicit
 * stock-exhaustion wording so they cleanly separate out-of-stock from the
 * "we don't carry / we don't have that product / not in our catalog" deflections
 * (which carry no stock wording and must still escalate).
 */
const OUT_OF_STOCK_PATTERNS: RegExp[] = [
  // English
  /\bout of stock\b/,
  /\bsold out\b/,
  /\bnot in stock\b/,
  /\bno longer in stock\b/,
  /\bout of inventory\b/,
  /\b(currently|temporarily) out of stock\b/,
  /\b(back in stock|restock|restocked|restocking)\b/,
  // Albanian — "stok" (stock) / "gjendje" (inventory) anchored
  /\bjashte stokut\b/,
  /\b(nuk|s) (eshte|ka) (ne )?stok\b/,
  /\bpa stok\b/,
  /\bstoku (ka )?mbaruar\b/,
  /\bka mbaruar (nga )?stoku\b/,
  /\bjashte gjendje\b/,
];

/**
 * True when the reply states the product is OUT OF STOCK (as opposed to not
 * carried / unknown). Deterministic and side-effect free. Out-of-stock replies
 * are sent to the customer unchanged and are never escalated by this guard.
 */
export function isOutOfStockReply(replyText: string): boolean {
  const text = normalize(replyText);
  if (!text) return false;
  return OUT_OF_STOCK_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * True when the reply text is a generic knowledge/uncertainty deflection.
 *
 * Deterministic and side-effect free. Detects ONLY the negative-knowledge /
 * uncertainty wording above; negative-availability ("we don't have that product")
 * is detected separately by the caller via the availability classifier and is
 * passed into `shouldEscalateUncertainAnswer` rather than re-implemented here.
 */
export function isUncertainDeflection(replyText: string): boolean {
  const text = normalize(replyText);
  if (!text) return false;
  return DEFLECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export interface UncertainAnswerDecisionInput {
  /** The fully-composed reply about to be sent. */
  replyText: string;
  /** Master switch — when false the guard never fires (raw AI behaviour preserved). */
  enabled: boolean;
  /** True when an earlier escalation already replaced/handled this turn. */
  alreadyEscalated: boolean;
  /** True when the reply is the deliberate canned out-of-stock message. */
  isOosCannedReply: boolean;
  /** True when the reply is part of the order flow (confirmation/details collection). */
  isOrderFlowReply: boolean;
  /** Result of the upstream negative-availability classifier for this reply. */
  negativeAvailabilityDetected: boolean;
}

/**
 * Pure decision predicate combining every signal and exclusion. Returns true when
 * the caller should replace the reply with the holding message and escalate.
 *
 * Fires when (a) the guard is enabled, (b) no earlier escalation already handled
 * the turn, (c) the reply is not a legitimate out-of-stock or order-flow message,
 * and (d) the reply is EITHER a knowledge/uncertainty deflection (deterministic)
 * OR a negative-availability deflection (from the upstream classifier).
 *
 * Out-of-stock replies are explicitly NOT escalated: an out-of-stock answer is
 * reliable information the business wants delivered to the customer as-is. This is
 * what separates "the product is out of stock" (sent) from "we don't carry that
 * product" (escalated) — only the latter lacks stock wording.
 */
export function shouldEscalateUncertainAnswer(input: UncertainAnswerDecisionInput): boolean {
  if (!input.enabled) return false;
  if (input.alreadyEscalated) return false;
  if (input.isOosCannedReply) return false;
  if (input.isOrderFlowReply) return false;
  // Out-of-stock is legitimate info → deliver as-is, never escalate.
  if (isOutOfStockReply(input.replyText)) return false;
  return input.negativeAvailabilityDetected || isUncertainDeflection(input.replyText);
}
