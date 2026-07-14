/**
 * P2-3 (RC-13) — the slot-backed older-context summary projector. The legacy summarizer
 * (`summarizeOlderConversationContext`) was CUSTOMER-MESSAGE-ONLY: it discarded every assistant
 * turn (prices, recommendations, ETAs) and could not carry a fact that had slid entirely out of the
 * 40-row window. This projector instead derives the summary from the PERSISTED slot store (name /
 * phone / address / order_stage, migration 077) + the last-recommendation anchor (migration 078) —
 * which survive regardless of window depth — PLUS a bounded extractive tail over the older
 * (delivery-filtered) segment that is a strict SUPERSET of what the legacy summary carried.
 *
 * Pure and network-free (no I/O, no DB, no OpenAI) — fully unit-testable. The caller resolves the
 * slots (from the conversation row) and the recommended products (active/in-stock only, via
 * `findActiveProductsByIds`) and passes normalized message text in, so this module never touches
 * the catalog, the DB, or `aiService` internals.
 *
 * Determinism (RC-03): same input → identical output (no Date/random). Token-bounded (RC-26): the
 * extractive tail is capped so the summary cannot blow the unbudgeted system prompt.
 */

/** Persisted conversation slots (migration 077/078). NULL/undefined fields are simply omitted. */
export interface SummarySlots {
  name?: string | null;
  phone?: string | null;
  address?: string | null;
  orderStage?: string | null;
}

/** A previously-recommended product, pre-resolved to active/in-stock by the caller. */
export interface SummaryProduct {
  name: string;
  price?: number | null;
  discountedPrice?: number | null;
}

/** A normalized older-segment message: `text` is already formatted the same way the prompt uses it. */
export interface SummaryMessage {
  isCustomer: boolean;
  text: string;
}

export interface BuildConversationSummaryArgs {
  slots: SummarySlots;
  recommendedProducts: SummaryProduct[];
  /** The older segment (everything before the recent raw window), already delivery-filtered. */
  olderMessages: SummaryMessage[];
  /** Hard cap on the extractive-tail characters (default 600) — the RC-26 token guard. */
  maxTailChars?: number;
}

const DEFAULT_MAX_TAIL_CHARS = 600;

function collapse(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function preview(text: string, limit: number): string | null {
  const collapsed = collapse(text);
  if (!collapsed) return null;
  return `${collapsed.slice(0, limit)}${collapsed.length > limit ? '...' : ''}`;
}

function formatPrice(product: SummaryProduct): string | null {
  const effective =
    typeof product.discountedPrice === 'number' && product.discountedPrice > 0
      ? product.discountedPrice
      : typeof product.price === 'number' && product.price > 0
        ? product.price
        : null;
  return effective === null ? null : `€${effective}`;
}

/**
 * Build the slot-backed older-context summary. Returns `null` when there is no older segment AND no
 * persisted facts to carry (parity with the legacy trigger — nothing to inject). NULL/absent slots
 * are treated as "unknown": the line is omitted, never emitted as "name: null", and never throws
 * (this is what makes flipping the flag ON mid-conversation degrade gracefully — the persisted slots
 * are simply empty on in-flight threads until later turns populate them, and the extractive tail
 * carries the load-bearing customer facts in the meantime).
 */
export function buildConversationSummary(args: BuildConversationSummaryArgs): string | null {
  const { slots, recommendedProducts, olderMessages } = args;
  const maxTailChars =
    typeof args.maxTailChars === 'number' && args.maxTailChars > 0
      ? args.maxTailChars
      : DEFAULT_MAX_TAIL_CHARS;

  const hasSlots = Boolean(slots.name || slots.phone || slots.address || slots.orderStage);
  const hasRecs = recommendedProducts.length > 0;
  if (olderMessages.length === 0 && !hasSlots && !hasRecs) return null;

  const parts: string[] = [];

  // 1) Persisted, load-bearing order facts — survive regardless of window depth (RC-13 core).
  if (hasSlots) {
    const known: string[] = [];
    if (slots.name) known.push(`customer name: ${collapse(slots.name)}`);
    if (slots.phone) known.push(`phone: ${collapse(slots.phone)}`);
    if (slots.address) known.push(`delivery address: ${collapse(slots.address)}`);
    if (slots.orderStage) known.push(`order stage: ${collapse(slots.orderStage)}`);
    parts.push(`Known order details already provided by the customer — ${known.join('; ')}.`);
  }

  // 2) Previously recommended, still-in-stock products (RC-13: never deny a prior in-stock rec).
  if (hasRecs) {
    const listed = recommendedProducts
      .map((p) => {
        const price = formatPrice(p);
        return price ? `${collapse(p.name)} (${price})` : collapse(p.name);
      })
      .filter((s) => s.length > 0);
    if (listed.length > 0) {
      parts.push(`Products already recommended to the customer (still in stock): ${listed.join(', ')}.`);
    }
  }

  // 3) Bounded extractive tail over the older segment — a strict superset of the legacy summary's
  //    load-bearing content (same previews + last-2 customer highlights), plus the last delivered
  //    assistant preview so a stated price/ETA is not lost.
  const tail: string[] = [];
  if (olderMessages.length > 0) {
    const total = olderMessages.length;
    const customerMessages = olderMessages.filter((m) => m.isCustomer);
    const assistantMessages = olderMessages.filter((m) => !m.isCustomer);

    const firstPreview = preview(olderMessages[0].text, 140);
    const lastPreview = preview(olderMessages[total - 1].text, 140);

    tail.push(
      `Earlier context (${total} older messages): customer sent ${customerMessages.length}, ` +
        `assistant sent ${assistantMessages.length}.`,
    );
    if (firstPreview) tail.push(`The earlier thread starts with: "${firstPreview}".`);
    if (lastPreview) {
      tail.push(`Before the recent window, it most recently included: "${lastPreview}".`);
    }

    const customerHighlights = customerMessages
      .map((m) => collapse(m.text))
      .filter((t) => t.length > 0)
      .slice(-2)
      .map((t) => `"${t.slice(0, 120)}${t.length > 120 ? '...' : ''}"`);
    if (customerHighlights.length > 0) {
      tail.push(`Notable recent customer points: ${customerHighlights.join(' | ')}.`);
    }

    const lastAssistant = [...assistantMessages].reverse().find((m) => collapse(m.text).length > 0);
    const lastAssistantPreview = lastAssistant ? preview(lastAssistant.text, 140) : null;
    if (lastAssistantPreview) {
      tail.push(`The assistant most recently said: "${lastAssistantPreview}".`);
    }
  }

  let tailText = tail.join(' ');
  if (tailText.length > maxTailChars) {
    tailText = `${tailText.slice(0, maxTailChars).trimEnd()}...`;
  }
  if (tailText) parts.push(tailText);

  const summary = parts.join(' ').trim();
  return summary.length > 0 ? summary : null;
}
