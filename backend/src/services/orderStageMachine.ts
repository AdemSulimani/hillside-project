/**
 * P2-2 (RC-07, RC-08, RC-22) — the deterministic order-lifecycle state machine.
 *
 * Replaces three per-turn stochastic LLM order-classifiers with a pure transition function over a
 * persisted stage + boolean signals:
 *   - `classifyNewOrderSignal`        -> a deterministic new-order lexicon, honored ONLY in `confirmed`
 *   - `detectOrderAffirmationIntent`  -> the consent lexicon, honored ONLY in `awaiting_confirmation`
 *                                        (there is NO confidence field to boost or omit -> RC-07's
 *                                        asymmetry vanishes by construction)
 *   - `hasAssistantAskedOrderClosingInConversation` (~40 LLM calls) -> a persisted boolean
 *
 * `decideOrderStage` reproduces the legacy 7-conjunct `passesDraftOrderValidation`
 * (`processAIReply.ts`) one-to-one but as a deterministic function of the stored stage and the
 * turn's slots/signals: `shouldCreateOrder = slotsComplete && (consentInAwaiting || repeatOrder)`.
 *
 * Pure and network-free (no I/O, no DB, no OpenAI) — fully unit-testable in-process, mirroring
 * `classifierConfidenceContract.ts` / `groundingGate.ts`.
 */
import type { OrderStage } from '../db/models/conversation';
import { GHEG_LEXICONS, GHEG_ORDER_CONSENT_EXTRA_PATTERNS } from './ghegLexicons';
import { includesAnyKeyword } from './usageSuitabilityHelpers';

export type { OrderStage };

// ---------------------------------------------------------------------------
// Consolidated deterministic order lexicons (the LLM replacements' signal source).
//
// Faithful ports of the legacy detectors so the FSM path and the legacy flag-off path agree during
// the shadow window: `detectNewOrderSignalLexical` mirrors `classifyNewOrderSignal`'s keyword
// fallback (aiService.ts) and `detectOrderConsentLexical` mirrors `looksLikeOrderAffirmation`
// (processAIReply.ts). The legacy functions are left untouched (flag-off preserves byte-for-byte);
// these are the tested, consolidated home the cutover uses.
// ---------------------------------------------------------------------------

/** Diacritic-folded, whitespace-collapsed lowercase — mirrors `normalizeEscalationMessage`. */
function normalizeLexical(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** New/additional-order keywords (both diacritic and diacritic-free forms; matcher only lowercases). */
const NEW_ORDER_SIGNAL_KEYWORDS = [
  'new order',
  'another order',
  'one more',
  'again',
  'also order',
  'order again',
  'porosi tjeter',
  'porosi tjetër',
  'edhe nje',
  'edhe një',
  'nje tjeter',
  'një tjetër',
  'dua edhe',
  'shto edhe',
];

/**
 * Deterministic replacement for `classifyNewOrderSignal` — the lexical core the LLM classifier
 * already falls back to. An additional/repeat-order request. Honored by the FSM ONLY in `confirmed`.
 */
export function detectNewOrderSignalLexical(message: string): boolean {
  const inbound = (message ?? '').trim();
  if (!inbound) return false;
  return includesAnyKeyword(inbound, NEW_ORDER_SIGNAL_KEYWORDS);
}

/**
 * Deterministic replacement for `detectOrderAffirmationIntent` — the consolidated consent lexicon
 * (incl. Gheg forms `ne rregull`, `mire`, `dakord`, `pranoj`, `bone`/`boje`/`kryeje`, `vec bone`).
 * Faithful port of `looksLikeOrderAffirmation`. There is NO confidence field -> RC-07's boost
 * asymmetry cannot arise. The FSM honors it ONLY in `awaiting_confirmation` (the `po`-in-a-complaint
 * guard), so a stray affirmation in open conversation can never create an order.
 */
export function detectOrderConsentLexical(text: string, ghegEnabled: boolean = GHEG_LEXICONS): boolean {
  const normalized = normalizeLexical(text ?? '');
  if (!normalized) return false;
  return (
    /^(po|ok|okej|yes|yep|sure|alright)\b/.test(normalized) ||
    /^(ne rregull|nrregull|mire|shume mire|dakord|pranoj|pranoje)\b/.test(normalized) ||
    /^((vec|veq)\s+)?(bone|boje|kryeje|kryej)\b/.test(normalized) ||
    /(dua|dush|do|doni|please|ju lutem).*(porosi|order)/.test(normalized) ||
    /(beje porosine|beje porosin|place the order|make the order)/.test(normalized) ||
    /^(po ju lutem|po beje|beje|ok beje)$/.test(normalized) ||
    /(can|could|may|i want to|i'd like to|i would like to|wish to|how (do|can) i).*(order|porosi)/.test(normalized) ||
    /(a mund|mund ta|a mund ta).*(porosi|order)/.test(normalized) ||
    /(want|dua|deshiroj).*(order|porosi)/.test(normalized) ||
    /(order|porosi).*(this|kete|product|produkt|it|ate)/.test(normalized) ||
    // P2-5 (RC-25): Gheg consent forms. Safe to widen here and ONLY here — the FSM honors
    // this lexicon exclusively in `awaiting_confirmation`. The legacy
    // `looksLikeOrderAffirmation` is NOT stage-gated and is deliberately left untouched.
    (ghegEnabled && GHEG_ORDER_CONSENT_EXTRA_PATTERNS.some((re) => re.test(normalized)))
  );
}

// ---------------------------------------------------------------------------
// The pure FSM
// ---------------------------------------------------------------------------

/** The six factual conjuncts of the legacy draft-order gate (conjuncts 1–6). */
export interface OrderSlots {
  /** intent.product_name != null (conjunct 3). */
  hasProduct: boolean;
  /** hasDeliveryAddress (conjunct 4). */
  hasAddress: boolean;
  /** hasCustomerPhone (conjunct 5). */
  hasPhone: boolean;
  /** hasCustomerName (conjunct 6). */
  hasName: boolean;
  /** intent.is_ready_to_order (conjunct 1). */
  isReadyToOrder: boolean;
  /** passesConfidenceGate(intent.intent_score, threshold, symmetry) (conjunct 2). */
  intentScorePasses: boolean;
}

/** All six factual conjuncts present — the deterministic precondition for creating an order. */
export function slotsComplete(s: OrderSlots): boolean {
  return (
    s.hasProduct && s.hasAddress && s.hasPhone && s.hasName && s.isReadyToOrder && s.intentScorePasses
  );
}

/** Deterministic per-turn signals derived from the merged inbound text + post-confirmation history. */
export interface InboundSignals {
  /** detectOrderConsentLexical over the customer messages after the data-confirmation request. */
  consentDetected: boolean;
  /** detectNewOrderSignalLexical(inboundText) — an additional/repeat-order request. */
  newOrderDetected: boolean;
  /** messageLooksLikeOrderDetailsPayload(inboundText) — a name/phone/address payload this turn. */
  providesOrderDetails: boolean;
}

export type OrderStageEvent =
  | { kind: 'inbound'; slots: OrderSlots; signals: InboundSignals; orderClosingAsked: boolean }
  | { kind: 'assistant_data_confirmation_sent' }
  | { kind: 'assistant_order_closing_asked' }
  | { kind: 'order_created' };

export interface StageDecision {
  nextStage: OrderStage;
  /** True only on an `inbound` event that satisfies the deterministic create gate. */
  shouldCreateOrder: boolean;
}

/** NULL / unknown (legacy rows) -> `browsing`; a valid stored value round-trips. */
export function normalizeStage(raw: string | null | undefined): OrderStage {
  return raw === 'collecting' || raw === 'awaiting_confirmation' || raw === 'confirmed' ? raw : 'browsing';
}

/**
 * The order_stage the FSM should evaluate this turn. Trust the persisted column when it has been
 * set; for a legacy row whose column is still NULL, derive it deterministically from history (the
 * same signals the legacy gate uses) so the decision is independent of the lazy-seed timing.
 *
 * The history evidence (`dataConfirmationSent` — did any assistant turn actually send the
 * data-confirmation ask?) is OR'ed in even when a persisted stage exists: the post-send marker
 * writes are best-effort (a failure is logged and swallowed), so a transient DB blip on that one
 * UPDATE can strand the column at 'collecting' after the ask was actually sent — and a stage that
 * ignored history would then silently refuse the customer's consent forever (the RC-22
 * silent-forfeiture shape through a new mechanism). History only moves the stage FORWARD to
 * `awaiting_confirmation`; it never downgrades a persisted later stage.
 */
export function deriveEffectiveOrderStage(
  persisted: string | null | undefined,
  dataConfirmationSent: boolean,
  intent: { product_name: string | null; is_ready_to_order: boolean },
): OrderStage {
  if (persisted != null) {
    const stage = normalizeStage(persisted);
    if (dataConfirmationSent && (stage === 'browsing' || stage === 'collecting')) {
      return 'awaiting_confirmation';
    }
    return stage;
  }
  if (dataConfirmationSent) return 'awaiting_confirmation';
  if (intent.product_name != null || intent.is_ready_to_order === true) return 'collecting';
  return 'browsing';
}

/**
 * The pure FSM transition. Given the current stage and an event, returns the next stage and whether
 * an order should be created this turn. Deterministic: the same `(current, event)` always yields the
 * same decision.
 *
 * Create gate (reproduces `passesDraftOrderValidation`):
 *   `slotsComplete(slots)` (conjuncts 1–6) AND
 *   ( consent in `awaiting_confirmation` = consentDetected OR (providesOrderDetails && orderClosingAsked) )
 *   OR ( repeat order = stage is `confirmed` AND newOrderDetected ).
 *
 * Consent is honored ONLY in `awaiting_confirmation` (the `po`-in-a-complaint guard); a new-order
 * signal is honored ONLY after a prior order exists (`confirmed`) — the I3 bypass is re-expressed
 * as a stage precondition, so a first-ever order always transits `awaiting_confirmation`.
 */
export function decideOrderStage(current: OrderStage, event: OrderStageEvent): StageDecision {
  switch (event.kind) {
    case 'order_created':
      return { nextStage: 'confirmed', shouldCreateOrder: false };

    case 'assistant_data_confirmation_sent':
      // Don't regress a placed order; otherwise the data-confirmation ask enters awaiting.
      return {
        nextStage: current === 'confirmed' ? 'confirmed' : 'awaiting_confirmation',
        shouldCreateOrder: false,
      };

    case 'assistant_order_closing_asked':
      return { nextStage: current === 'browsing' ? 'collecting' : current, shouldCreateOrder: false };

    case 'inbound': {
      const complete = slotsComplete(event.slots);
      const consentInAwaiting =
        current === 'awaiting_confirmation' &&
        (event.signals.consentDetected ||
          (event.signals.providesOrderDetails && event.orderClosingAsked));
      const repeatOrder = current === 'confirmed' && event.signals.newOrderDetected;
      const shouldCreateOrder = complete && (consentInAwaiting || repeatOrder);
      if (shouldCreateOrder) {
        return { nextStage: 'confirmed', shouldCreateOrder: true };
      }

      // No order this turn — advance the collection stage where appropriate.
      let nextStage: OrderStage = current;
      if (current === 'browsing' && (event.slots.hasProduct || event.slots.isReadyToOrder)) {
        nextStage = 'collecting';
      } else if (current === 'confirmed' && event.signals.newOrderDetected) {
        // A repeat request whose slots aren't yet complete re-opens a collection cycle.
        nextStage = 'collecting';
      }
      return { nextStage, shouldCreateOrder: false };
    }
  }
}
