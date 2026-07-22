import type { Product } from '../db/models/product';
import type {
  OrderProductResolution,
  OrderProductResolutionReason,
} from './orderProductResolutionService';

/**
 * Pure assembly of an order's product lines from per-item resolution results (migration 088,
 * multi-product orders). DB- and OpenAI-free so it is fully unit-testable, mirroring the style of
 * orderStageMachine.ts / commissionWindow.ts.
 *
 * The pipeline resolves each `intent.items[i]` to a catalog product independently (via the unchanged
 * `resolveOrderProduct`), then hands the results here. This module:
 *   - buckets items that cannot become a line (ambiguous variant, no catalog match, out of stock)
 *     so the caller can skip/clarify per line while still registering the rest — never sinking a
 *     confirmed order over one unresolved product;
 *   - merges identical products (same product_id) into one line with summed quantity;
 *   - prices each line at the base catalog price (see the order-line-price decision, 2026-07-21:
 *     the AI quotes the base price by default and only offers `discounted_price` on explicit
 *     negotiation, which the order-extraction step cannot observe);
 *   - sums the line totals into the order total the caller commissions on.
 */

export interface AssemblyInputItem {
  /** Result of resolving one requested product to a catalog product. */
  resolution: OrderProductResolution;
  /** The quantity the customer asked for on this item (null ⇒ 1). */
  requestedQuantity: number | null;
}

export interface AssembledLine {
  product: Product;
  product_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
}

export type SkippedLineReason = OrderProductResolutionReason | 'out_of_stock';

export interface SkippedItem {
  reason: SkippedLineReason;
  /** Best available product name for logging (candidate/resolved name), or null when unknown. */
  productName: string | null;
  /** Populated only for `ambiguous` — the variant candidates to offer the customer. */
  candidates: Product[];
}

export interface OrderAssembly {
  /** The resolvable, in-stock lines to persist, in first-seen order. */
  lines: AssembledLine[];
  /** Sum of the line totals (2dp), the amount commission is computed on. */
  orderTotal: number;
  ambiguous: SkippedItem[];
  outOfStock: SkippedItem[];
  unmatched: SkippedItem[];
  /** Raw product names of the resolvable lines; the pipeline normalizes these for order-level dedupe. */
  resolvedNames: string[];
}

/** Unit price recorded per line: the base catalog `price`. Kept as one named site for the pricing rule. */
export function effectivePrice(product: Pick<Product, 'price'>): number {
  return Number(product.price);
}

/** Round to 2dp the way NUMERIC(12,2) stores, so in-memory totals match the persisted values. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function assembleOrderLines(items: AssemblyInputItem[]): OrderAssembly {
  const ambiguous: SkippedItem[] = [];
  const outOfStock: SkippedItem[] = [];
  const unmatched: SkippedItem[] = [];

  // Merge identical product_id into one line, preserving first-seen order for a stable item_index.
  const mergedById = new Map<string, AssembledLine>();
  const seenOrder: string[] = [];

  for (const { resolution, requestedQuantity } of items) {
    if (resolution.ambiguous) {
      ambiguous.push({
        reason: 'ambiguous',
        productName: resolution.candidates[0]?.name ?? null,
        candidates: resolution.candidates,
      });
      continue;
    }
    const product = resolution.product;
    if (!product) {
      unmatched.push({ reason: resolution.reason, productName: null, candidates: [] });
      continue;
    }
    if (product.in_stock === false) {
      outOfStock.push({ reason: 'out_of_stock', productName: product.name, candidates: [] });
      continue;
    }

    const qty = Math.max(1, Math.floor(requestedQuantity ?? 1));
    const existing = mergedById.get(product.id);
    if (existing) {
      existing.quantity += qty;
      existing.total_price = round2(existing.unit_price * existing.quantity);
    } else {
      const unit = effectivePrice(product);
      mergedById.set(product.id, {
        product,
        product_id: product.id,
        product_name: product.name,
        quantity: qty,
        unit_price: unit,
        total_price: round2(unit * qty),
      });
      seenOrder.push(product.id);
    }
  }

  const lines = seenOrder.map((id) => mergedById.get(id)!);
  const orderTotal = round2(lines.reduce((sum, l) => sum + l.total_price, 0));
  const resolvedNames = lines.map((l) => l.product_name);

  return { lines, orderTotal, ambiguous, outOfStock, unmatched, resolvedNames };
}
