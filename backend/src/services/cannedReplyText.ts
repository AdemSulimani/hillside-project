/**
 * P2-3 (RC-16) — the canonical canned/holding reply constants + a pure classifier that recognises
 * them, extracted from `jobs/processAIReply.ts` so BOTH the reply orchestrator and the history
 * assembler (`services/aiService.ts`) share ONE source of truth. This closes the drift risk of
 * matching against duplicated strings: `processAIReply` re-imports these constants, and the
 * delivery-filtered transcript maps any message whose text is one of them to the `system` role
 * (delivered holding/escalation/procedural copy, not authoritative assistant grounding).
 *
 * Pure and network-free (no I/O, no DB) — fully unit-testable, mirroring `groundingGate.ts` /
 * `orderStageMachine.ts`. `ReplyLocale` is imported type-only so there is no runtime import cycle
 * with `aiService.ts` (which imports `isCannedHoldingCopy` from here).
 *
 * LOCALE EXTENSION: to support a new reply locale, add an entry to ALL of the Record<ReplyLocale,…>
 * tables here AND to ORDER_CONFIRMATION_FOLLOW_UP / VARIANT_CLARIFICATION_LEAD_IN in
 * jobs/processAIReply.ts, productInformationGapHelpers.ts, and the aiService.ts locale-dispatch
 * tables. The normalized-string set below is derived from these tables, so a new locale is picked
 * up automatically by the classifier.
 */
import type { ReplyLocale } from './aiService';

/** Holding / escalation / ack copy sent instead of (or after) a substantive AI reply. */
export const HOLDING_MESSAGES: Record<
  ReplyLocale,
  {
    postPurchaseSupport: string;
    usageEscalation: string;
    productKnowledgeEscalation: string;
    orderInfoUpdated: string;
  }
> = {
  sq: {
    postPurchaseSupport:
      'Na vjen keq për problemin. Një anëtar i ekipit tonë do t’ju përgjigjet së shpejti.',
    usageEscalation:
      'Së shpejti do t’ju kontaktojë një specialist për këtë çështje.',
    productKnowledgeEscalation:
      'Së shpejti do t’ju kontaktojë një specialist me informacion të saktë për produktin.',
    orderInfoUpdated:
      'Informacioni i porosisë suaj u përditësua. Faleminderit!',
  },
  en: {
    postPurchaseSupport:
      'Sorry about the issue. A team member will get back to you shortly.',
    usageEscalation:
      'A specialist will contact you shortly about this matter.',
    productKnowledgeEscalation:
      'A product specialist will contact you shortly with accurate details.',
    orderInfoUpdated:
      'Your order info has been updated. Thank you!',
  },
};

/**
 * Sent after all order details have been collected, asking the customer to verify their name,
 * phone, and address before the order is registered. Must match verbatim so
 * messageIsDataConfirmationRequest can identify it in conversation history.
 */
export const DATA_CONFIRMATION_MESSAGES: Record<ReplyLocale, string> = {
  sq: 'Faleminderit për porosinë! A mund të konfirmoni që të dhënat që keni dhënë janë korrekte?',
  en: 'Thank you for your order! Please confirm the information you provided is correct.',
};

/**
 * Sent when the customer has provided phone and delivery address but has not yet given their first
 * name. Overrides any AI-generated reply (which might incorrectly confirm the order) to ensure the
 * name is explicitly collected before the data-confirmation step.
 */
export const MISSING_CUSTOMER_NAME_MESSAGES: Record<ReplyLocale, string> = {
  sq: 'Faleminderit për të dhënat! Për të plotësuar porosinë, na tregoni edhe emrin tuaj.',
  en: 'Thanks for your details! To complete your order, please share your first name.',
};

/**
 * Legacy verbatim usage-escalation strings that predate HOLDING_MESSAGES (still present in older
 * persisted conversations). Kept so the classifier recognises them as holding copy.
 */
const LEGACY_USAGE_ESCALATION_VARIANTS: readonly string[] = [
  "pershendetje, se shpejti do t'ju kontaktoje nje specialist lidhur me kete ceshtje.",
  'pershendetje, se shpejti do tju kontaktoje nje specialist lidhur me kete ceshtje.',
];

/** Diacritic-folding, whitespace-collapsing normalizer (mirrors processAIReply's normalizeEscalationMessage). */
export function normalizeCannedText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The normalized set of every canned system-copy string, built once from the tables above. */
const CANNED_SYSTEM_COPY_NORMALIZED: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const locale of Object.keys(HOLDING_MESSAGES) as ReplyLocale[]) {
    for (const text of Object.values(HOLDING_MESSAGES[locale])) {
      set.add(normalizeCannedText(text));
    }
    set.add(normalizeCannedText(DATA_CONFIRMATION_MESSAGES[locale]));
    set.add(normalizeCannedText(MISSING_CUSTOMER_NAME_MESSAGES[locale]));
  }
  for (const legacy of LEGACY_USAGE_ESCALATION_VARIANTS) {
    set.add(normalizeCannedText(legacy));
  }
  return set;
})();

/**
 * True when `content` is one of the canned holding / escalation / data-confirmation / missing-name
 * messages the platform sends (exact match after diacritic-folding normalization — these are always
 * emitted verbatim from the constants above, so an exact normalized match is precise and avoids
 * false-positives on genuine sales replies). Used by the delivery-filtered transcript to relabel
 * such a delivered message to the `system` role.
 */
export function isCannedHoldingCopy(content: string): boolean {
  const raw = (content ?? '').trim();
  if (!raw) return false;
  return CANNED_SYSTEM_COPY_NORMALIZED.has(normalizeCannedText(raw));
}
