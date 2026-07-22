/**
 * Pure purchase-intent payload mapping — the coercion/clamping half of intentDetectionService,
 * split into its own module so it is unit-testable WITHOUT importing openaiClient (which throws at
 * module load when OPENAI_API_KEY is unset, taking the whole test file down — see CLAUDE.md §11 and
 * the evalIsolation/harnessOfflineFence import-graph fences). No I/O, no OpenAI, no DB.
 */

/** One product line the customer is ordering. `product_name` is trimmed non-empty; `quantity` is a positive integer or null. */
export interface IntentOrderItem {
  product_name: string;
  quantity: number | null;
}

export interface IntentResult {
  intent_score: number;
  /** The PRIMARY product (mirrors items[0]); kept for every existing scalar reader. */
  product_name: string | null;
  /** The PRIMARY product's quantity (mirrors items[0].quantity). */
  quantity: number | null;
  /** Every distinct product the customer is ordering. Empty when none. Never loses the 2nd product. */
  items: IntentOrderItem[];
  delivery_address: string | null;
  customer_first_name: string | null;
  is_ready_to_order: boolean;
  reasoning: string;
}

export const EMPTY_INTENT_RESULT: IntentResult = {
  intent_score: 0,
  product_name: null,
  quantity: null,
  items: [],
  delivery_address: null,
  customer_first_name: null,
  is_ready_to_order: false,
  reasoning: '',
};

/**
 * Coerce one raw items[] entry with the SAME rules the scalars use: trim the name (drop the entry
 * if empty), floor a positive quantity (else null). Returns null for a non-object or nameless entry.
 */
export function coerceIntentItem(raw: unknown): IntentOrderItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const product_name =
    typeof r.product_name === 'string' && r.product_name.trim() ? r.product_name.trim() : null;
  if (!product_name) return null;
  let quantity: number | null = null;
  if (typeof r.quantity === 'number' && Number.isFinite(r.quantity) && r.quantity > 0) {
    quantity = Math.floor(r.quantity);
  }
  return { product_name, quantity };
}

/**
 * Maps a parsed intent payload to the coerced/clamped {@link IntentResult}. Shared by the legacy
 * fail-open `json_object` path and the strict `json_schema` path so both produce identical results
 * from identical JSON — the only difference is response_format + the malformed-output fail policy.
 */
export function mapIntentPayload(parsed: Record<string, unknown>): IntentResult {
  // Preserve the legacy number-only coercion EXACTLY (a stringified score stays 0) so the flag-off
  // path is byte-for-byte identical. Strict json_schema guarantees a number on the flag-on path, so
  // this is equally correct there — deliberately NOT routed through normalizeClassifierConfidence,
  // whose extra numeric-string parsing would change flag-off order-creation behaviour.
  const intentScoreRaw = parsed.intent_score;
  let intent_score = 0;
  if (typeof intentScoreRaw === 'number' && Number.isFinite(intentScoreRaw)) {
    intent_score = intentScoreRaw > 1 ? intentScoreRaw / 100 : intentScoreRaw;
  }
  intent_score = Math.min(1, Math.max(0, intent_score));

  const legacyProductName =
    typeof parsed.product_name === 'string' && parsed.product_name.trim()
      ? parsed.product_name.trim()
      : null;

  let legacyQuantity: number | null = null;
  if (typeof parsed.quantity === 'number' && Number.isFinite(parsed.quantity) && parsed.quantity > 0) {
    legacyQuantity = Math.floor(parsed.quantity);
  }

  // Multi-product (migration 088): parse items[] with the SAME coercion as the scalars, dropping
  // nameless entries. The scalar product_name/quantity is then the PRIMARY (first) item when the
  // model returned any — keeping every existing scalar reader (order gating, the FSM,
  // orderStageMachine, persistOrderSlots, logs) working unchanged — else the legacy scalar parse.
  const items: IntentOrderItem[] = [];
  if (Array.isArray(parsed.items)) {
    for (const entry of parsed.items) {
      const item = coerceIntentItem(entry);
      if (item) items.push(item);
    }
  }
  const product_name = items.length > 0 ? items[0].product_name : legacyProductName;
  const quantity = items.length > 0 ? items[0].quantity : legacyQuantity;
  // Backward-compat bridge: no items but a named scalar product ⇒ synthesize one line. Covers the
  // legacy/flag-off prompt AND cached pre-deploy verdicts (classifierVerdictStore, 6h TTL) whose
  // JSON predates `items`, so an in-flight conversation degrades to single-line rather than losing
  // the order entirely.
  if (items.length === 0 && product_name != null) {
    items.push({ product_name, quantity });
  }

  const delivery_address =
    typeof parsed.delivery_address === 'string' && parsed.delivery_address.trim()
      ? parsed.delivery_address.trim()
      : null;

  const customer_first_name =
    typeof parsed.customer_first_name === 'string' && parsed.customer_first_name.trim()
      ? parsed.customer_first_name.trim()
      : null;

  const is_ready_to_order = parsed.is_ready_to_order === true;

  const reasoning =
    typeof parsed.reasoning === 'string' && parsed.reasoning.trim()
      ? parsed.reasoning.trim()
      : '';

  return {
    intent_score,
    product_name,
    quantity,
    items,
    delivery_address,
    customer_first_name,
    is_ready_to_order,
    reasoning,
  };
}
