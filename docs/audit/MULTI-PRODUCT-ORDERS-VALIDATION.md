# Multi-product orders — root cause, fix, and validation (2026-07-21)

Branch `fix/alert-noise-pause-policy`. Fixes the reported bug: when a customer orders two or more
products in one conversation (e.g. a protein **and** a creatine), the AI accepts the whole order in
its reply, but the Orders tab registers only **one** product and the 5% commission is computed on
that one product only.

## Root cause

The stack was **single-product by design at every layer**, and the loss began *before* persistence —
not in reply generation (which correctly enumerates every product and was left untouched).

| Layer | Single-product assumption |
|---|---|
| **Order extraction** (first loss point) | `services/intentDetectionService.ts` returned a **scalar** `product_name`/`quantity`. This classifier is separate from reply generation and can only ever capture ONE product, so the second was discarded before any DB write. |
| Pipeline | `jobs/processAIReply.ts` (`runOrderDetectionTail`) resolved ONE product, priced it, and called `createOrder` **once** — no loop. |
| Model + schema | `db/models/order.ts` `createOrder` was a single-row INSERT; `orders` (migration 014) has flat `product_id/product_name/quantity/unit_price/total_price` columns. **No `order_items`/line-item table existed** anywhere in the 88 migrations. |
| API + frontend | Controller serialized flat rows; `types/order.ts`, `ordersApi.ts`, `OrdersPage.tsx`, `OrderDetailDrawer.tsx` all assumed one product per order. |
| Commission | 5% of the one resolved product's `total_price`. |

## Fix (normalized child table; header kept as a maintained mirror)

Add an `order_items` child table and keep the `orders` header row as a maintained mirror — primary
line (highest line total) for `product_id/product_name/unit_price`, **SUM** for
`quantity/total_price/commission_amount` — so every legacy single-product reader keeps working. For a
single-line order the header is byte-identical to today.

1. **Migration `088_create_order_items.sql`** (+ `.down.sql`) — `order_items(order_id ON DELETE
   CASCADE, tenant_id, product_id ON DELETE SET NULL, product_name, quantity, unit_price,
   total_price, item_index)`; indexes incl. unique `(order_id, item_index)`. Idempotent backfill:
   one line per existing order mirroring its current columns. Additive DDL, rides the batch txn.
2. **`db/models/order.ts`** — `OrderItem`/`CreateOrderItemInput` types + `items` on `Order`;
   `createOrder(items)` is now **transactional** (header + lines), deriving the header mirror/sum
   inside the model so a caller can't desync it (synthesizes one line from the scalar fields when
   no `items` given). `listOrderItemsForOrder` + batched `listOrderItemsForOrders` (no N+1);
   readers (`listOrdersForTenant`, `findOrderWithRelationsForTenant`,
   `listActionRequiredOrdersForTenant`, `listOrdersForContactForTenant`) attach items.
   `recomputeOrderHeaderFromItems` is the **sole writer** of the mirror; `updateDraftOrderForTenant`
   applies a quantity edit to the primary line then recomputes.
3. **Intent extraction** — `services/intentDetectionService.ts` gained an `items[]` array; the scalar
   `product_name`/`quantity` is derived from the primary (first) item so every existing scalar reader
   (order gating, the FSM, `orderStageMachine`, `persistOrderSlots`, logs) is unchanged. A
   **backward-compat bridge** synthesizes `items` from the scalar when absent — covers the flag-off
   prompt AND cached pre-deploy verdicts (`classifierVerdictStore`, 6h TTL). The pure mapping was
   split into **`services/intentPayload.ts`** (openaiClient-free) so `mapIntentPayload` is
   unit-testable without the module-load key throw.
4. **Pipeline** — `jobs/processAIReply.ts` `runOrderDetectionTail` resolves each `intent.items[i]`
   (resolver unchanged), then the pure **`services/orderLineAssembly.ts`** merges duplicate products,
   buckets ambiguous/out-of-stock/unmatched items, prices each line and sums the total. Order-level
   dedupe generalized to a resolved-name **set** vs the existing order's line names. Commission = 5%
   of the summed total. One `createOrder` call with all lines; `order_created` analytics gains
   `item_count` + line list.
5. **Frontend** — `items[]` on the Order types; `ordersApi` normalizer with a synth fallback (renders
   pre-088/cached payloads); a `+N më shumë` badge on the list row + action-required card; a full
   line-item list with per-line price/total + grand total in the detail drawer (single-quantity edit
   kept for single-line orders; multi-line editing deferred, shown read-only).

Gated behind knob **`MULTI_PRODUCT_ORDERS`** (default **off**, frozen/fingerprinted; manifest +
`.env.example`). **Off = byte-for-byte single-product** (uses `items[0]` only); the whole feature is
inert until the flag flips.

### Product decisions (owner-confirmed)

- **Line price = BASE `price`**, not `discounted_price`. The reply prompt (`aiService.ts` ~2446)
  quotes base price by default and offers the discount only as a negotiation floor "when the customer
  asks", which the order step can't observe — so discounted-always would under-charge the common
  case. (Also leaves today's single-product economics unchanged.)
- **Partial orders:** register the lines that resolve cleanly; skip an out-of-stock line and send the
  existing variant-clarification for an ambiguous one. Never sink a confirmed order.
- **Post-creation additions** ("also add creatine" after an order already exists): create a **new
  second order** via the existing new-order-signal path, not an append.

## Offline validation

- `npm test`: **2248/2248** (473 suites) — includes 15 new tests across
  `orderLineAssembly.test.ts` (distinct-variant → 2 lines, same-product merge, out-of-stock skip,
  all-skipped → no order, Σ total, base-price precedence, 2dp rounding) and `intentMultiItem.test.ts`
  (multi-item parse, scalar-from-primary, backward-compat synth, bad-quantity coercion, nameless-item
  drop, score coercion).
- `npm run typecheck` clean; `npm run config:check` OK (**126 frozen knobs** — includes the new
  `MULTI_PRODUCT_ORDERS`); frontend `npm run build` (`tsc -b && vite build`) clean.

## Live validation (dev Postgres `localhost:5432`, tenant `02beb134…`, 257-product dev catalog)

- **Migration 088 applied** via `npm run migrate`. Backfill verified: **27 orders → 27 order_items**,
  0 orders without items, 0 tenant mismatches.
- **Real DB write/read/update path** exercised end-to-end with a throwaway script (2-item order,
  products `Pre-Pump pre-workout 1 Servim` ×2 @ 250 + `SET 50 KG` ×1 @ 155):

| Check | Result |
|---|---|
| `createOrder` writes 2 `order_items` rows | ✓ |
| header `total_price` = Σ lines (655), `quantity` = Σ (3) | ✓ |
| header primary product/unit_price = highest-total line (250) | ✓ |
| `commission_amount` = 5% of sum (32.75) | ✓ |
| detail read-back + `listOrderItemsForOrder` (ordered by item_index) + `listOrdersForTenant` attach 2 items | ✓ |
| `updateDraftOrderForTenant({quantity:5})` → primary line 5×250, header recomputed to 1405/qty 6, line B unchanged | ✓ |
| delete order → `order_items` cascade-deleted | ✓ |

**Bug caught by the live test:** the draft-quantity `UPDATE` used parameter `$3` in both an integer
context (`quantity = $3`) and a numeric one (`unit_price * $3`), so Postgres could not deduce one
type and errored (`42P08`, "numeric versus integer"). Fixed with explicit `$3::int` casts and re-run
to **15/15 green**. Dev DB restored (test order cascade-deleted).

### Scope note

The **database/model layer** was validated live against real Postgres. A full
webhook → AI-job → order-tail run with a live LLM was **not** executed — it needs the running app with
the BullMQ workers, an OpenAI key, and a simulated inbound conversation on a live channel. That path
is covered by the unit tests + the live DB test, and since `MULTI_PRODUCT_ORDERS` is off by default,
production behavior is unchanged until the flag is enabled in staging.

## Rollback

`MULTI_PRODUCT_ORDERS=off` instantly reverts order **creation** to single-product; the model/frontend
keep handling `items` harmlessly (existing orders each have exactly one line). Schema is additive;
leaving `order_items` in place after a flag-off is harmless. Full DB revert (`migrate:down 088`) is
safe only **before** multi-item is enabled in prod (afterward it would drop secondary lines; the
header retains the primary line, so single-product orders lose nothing). No eval-harness impact.

## Files

New: `db/migrations/088_create_order_items.sql` (+ `.down.sql`), `services/orderLineAssembly.ts`,
`services/intentPayload.ts`, `services/__tests__/orderLineAssembly.test.ts`,
`services/__tests__/intentMultiItem.test.ts`.
Modified: `db/models/order.ts`, `services/intentDetectionService.ts`, `jobs/processAIReply.ts`,
`config/knobs.ts`, `.env.example`; frontend `types/order.ts`, `api/ordersApi.ts`,
`pages/orders/OrdersPage.tsx`, `components/orders/OrderDetailDrawer.tsx`.
