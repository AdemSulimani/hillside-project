import type { PoolClient } from 'pg';
import pool from '../pool';
import {
  findConversationByIdForTenant,
  setConversationFullyAiHandled,
} from './conversation';
import { findContactById } from './contact';
import { findChannelById, type Channel, type ChannelType } from './channel';

export type OrderStatus =
  | 'draft'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export type ResolutionStatus = 'pending' | 'approved' | 'rejected' | 'store_credit_offered';

export type CommissionStatus = 'unpaid' | 'billed' | 'paid';

/**
 * A single product line on an order (migration 088). An order can carry N of these. The `orders`
 * header row mirrors the "primary line" (highest line total) plus the summed quantity/total, so
 * every legacy single-product reader keeps working; the full basket lives here.
 */
export interface OrderItem {
  id: string;
  order_id: string;
  tenant_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  item_index: number;
  created_at: Date;
  updated_at: Date;
}

export interface Order {
  id: string;
  tenant_id: string;
  conversation_id: string;
  contact_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  status: OrderStatus;
  customer_name: string;
  customer_phone: string | null;
  delivery_address: string | null;
  notes: string | null;
  detected_by: string;
  commission_amount: number | null;
  is_commissionable: boolean;
  commission_status: CommissionStatus;
  cancellation_reason: string | null;
  refund_reason: string | null;
  cancellation_requested_at: Date | null;
  refund_requested_at: Date | null;
  resolution_status: ResolutionStatus | null;
  resolution_notes: string | null;
  created_at: Date;
  updated_at: Date;
  /** The order's product lines, ordered by item_index. Empty when a reader did not load them. */
  items: OrderItem[];
}

/** A product line to insert on a new order. */
export interface CreateOrderItemInput {
  product_id?: string | null;
  product_name: string;
  quantity?: number;
  unit_price: number;
  total_price: number;
}

export interface CreateOrderInput {
  tenant_id: string;
  conversation_id: string;
  contact_id: string;
  product_id?: string | null;
  product_name: string;
  quantity?: number;
  unit_price: number;
  total_price: number;
  status?: OrderStatus;
  customer_name: string;
  customer_phone?: string | null;
  delivery_address?: string | null;
  notes?: string | null;
  detected_by?: string;
  is_commissionable?: boolean;
  commission_amount?: number | null;
  commission_status?: CommissionStatus;
  /**
   * The product lines for this order. When omitted/empty, a single line is synthesized from the
   * scalar product fields above (product_id/product_name/quantity/unit_price/total_price) — so
   * legacy single-product callers keep working unchanged. When present, the header's product
   * mirror and summed quantity/total are derived from these lines inside {@link createOrder}.
   */
  items?: CreateOrderItemInput[];
}

export type OrderListSortColumn =
  | 'created_at'
  | 'customer_name'
  | 'total_price'
  | 'quantity'
  | 'status';

export interface OrderListFilters {
  tenantId: string;
  status?: OrderStatus;
  conversationId?: string;
  search?: string;
  createdFrom?: Date;
  createdTo?: Date;
  page?: number;
  limit?: number;
  sortBy?: OrderListSortColumn;
  sortDir?: 'asc' | 'desc';
}

export interface OrderListItem extends Order {
  channel_type: ChannelType;
}

export interface OrderWithRelations extends Order {
  channel: Pick<Channel, 'id' | 'type' | 'name'>;
  conversation: {
    id: string;
    tenant_id: string;
    contact_id: string;
    channel_id: string | null;
    status: string;
    last_message_at: Date;
    human_override_until: Date | null;
    ai_paused: boolean;
    fully_ai_handled: boolean;
    human_replied: boolean;
    created_at: Date;
    updated_at: Date;
  };
  contact: {
    id: string;
    tenant_id: string;
    channel_id: string | null;
    external_id: string;
    name: string;
    avatar_url: string | null;
    metadata: Record<string, unknown>;
    notes: string | null;
    created_at: Date;
    updated_at: Date;
  };
}

export interface ActionRequiredOrder extends Order {
  contact_name: string;
  channel_type: ChannelType;
  conversation_id: string;
  request_reason: string | null;
}

export interface ResolveOrderActionInput {
  resolution_status: Exclude<ResolutionStatus, 'pending'>;
  resolution_notes: string | null;
}

export interface UpdateDraftOrderInput {
  quantity?: number;
  delivery_address?: string | null;
  notes?: string | null;
}

/**
 * Fields the AI is allowed to update on an existing order when a customer requests
 * a correction after the order has been placed. Unlike UpdateDraftOrderInput, this
 * works for any non-terminal order status (i.e. not cancelled or refunded) and
 * covers customer identity fields in addition to delivery details.
 */
export interface UpdateOrderCustomerInfoInput {
  delivery_address?: string | null;
  customer_name?: string;
  customer_phone?: string | null;
  notes?: string | null;
}

type OrderRow = Omit<Order, 'unit_price' | 'total_price' | 'commission_amount' | 'items'> & {
  unit_price: string | number;
  total_price: string | number;
  commission_amount: string | number | null;
};

function rowToOrder(row: OrderRow, items: OrderItem[] = []): Order {
  return {
    ...row,
    unit_price: Number(row.unit_price),
    total_price: Number(row.total_price),
    commission_amount:
      row.commission_amount !== null && row.commission_amount !== undefined
        ? Number(row.commission_amount)
        : null,
    is_commissionable: row.is_commissionable ?? false,
    commission_status: (row.commission_status as CommissionStatus) ?? 'unpaid',
    items,
  };
}

type OrderItemRow = Omit<OrderItem, 'unit_price' | 'total_price'> & {
  unit_price: string | number;
  total_price: string | number;
};

function rowToOrderItem(row: OrderItemRow): OrderItem {
  return {
    ...row,
    unit_price: Number(row.unit_price),
    total_price: Number(row.total_price),
  };
}

/** Normalize + index the caller's lines, synthesizing a single line from the scalar fields when none given. */
function buildOrderLines(input: CreateOrderInput): Array<Required<Omit<CreateOrderItemInput, 'quantity'>> & { quantity: number; item_index: number }> {
  const raw: CreateOrderItemInput[] =
    input.items && input.items.length > 0
      ? input.items
      : [
          {
            product_id: input.product_id ?? null,
            product_name: input.product_name,
            quantity: input.quantity ?? 1,
            unit_price: input.unit_price,
            total_price: input.total_price,
          },
        ];
  return raw.map((it, idx) => ({
    product_id: it.product_id ?? null,
    product_name: it.product_name,
    quantity: Math.max(1, Math.floor(it.quantity ?? 1)),
    unit_price: it.unit_price,
    total_price: it.total_price,
    item_index: idx,
  }));
}

/** Round to 2dp the way NUMERIC(12,2) stores, so the in-memory header matches what the DB persists. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const lines = buildOrderLines(input);
  // Header mirror is derived from the lines so the caller can never desync it from the basket:
  //   primary line = highest line total (tie-break: lowest item_index / insertion order)
  //   header quantity = SUM of line quantities; header total = SUM of line totals.
  const primary = lines.reduce((best, cur) => (cur.total_price > best.total_price ? cur : best), lines[0]);
  const headerQuantity = lines.reduce((s, l) => s + l.quantity, 0);
  const headerTotal = round2(lines.reduce((s, l) => s + l.total_price, 0));

  const isCommissionable = input.is_commissionable ?? false;
  const commissionAmount = input.commission_amount ?? null;
  const commissionStatus = input.commission_status ?? 'unpaid';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<OrderRow>(
      `INSERT INTO orders (
        tenant_id, conversation_id, contact_id, product_id, product_name, quantity,
        unit_price, total_price, status, customer_name, customer_phone, delivery_address, notes, detected_by,
        is_commissionable, commission_amount, commission_status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *`,
      [
        input.tenant_id,
        input.conversation_id,
        input.contact_id,
        primary.product_id,
        primary.product_name,
        headerQuantity,
        primary.unit_price,
        headerTotal,
        input.status ?? 'draft',
        input.customer_name,
        input.customer_phone ?? null,
        input.delivery_address ?? null,
        input.notes ?? null,
        input.detected_by ?? 'ai',
        isCommissionable,
        commissionAmount,
        commissionStatus,
      ],
    );
    const orderRow = rows[0];

    const itemRows: OrderItemRow[] = [];
    for (const l of lines) {
      const { rows: ir } = await client.query<OrderItemRow>(
        `INSERT INTO order_items (
           order_id, tenant_id, product_id, product_name, quantity, unit_price, total_price, item_index
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          orderRow.id,
          input.tenant_id,
          l.product_id,
          l.product_name,
          l.quantity,
          l.unit_price,
          l.total_price,
          l.item_index,
        ],
      );
      itemRows.push(ir[0]);
    }

    await client.query('COMMIT');
    return rowToOrder(orderRow, itemRows.map(rowToOrderItem));
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** All product lines for one order, ordered by item_index. Tenant-scoped. */
export async function listOrderItemsForOrder(tenantId: string, orderId: string): Promise<OrderItem[]> {
  const { rows } = await pool.query<OrderItemRow>(
    `SELECT * FROM order_items WHERE order_id = $2 AND tenant_id = $1 ORDER BY item_index ASC`,
    [tenantId, orderId],
  );
  return rows.map(rowToOrderItem);
}

/** Batched line load for a page of orders (avoids N+1). Returns a map of order_id → its lines. */
export async function listOrderItemsForOrders(
  tenantId: string,
  orderIds: string[],
): Promise<Map<string, OrderItem[]>> {
  const byOrder = new Map<string, OrderItem[]>();
  if (orderIds.length === 0) return byOrder;
  const { rows } = await pool.query<OrderItemRow>(
    `SELECT * FROM order_items WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY item_index ASC`,
    [tenantId, orderIds],
  );
  for (const r of rows) {
    const item = rowToOrderItem(r);
    const list = byOrder.get(item.order_id);
    if (list) list.push(item);
    else byOrder.set(item.order_id, [item]);
  }
  return byOrder;
}

/**
 * Recompute the `orders` header mirror + summed quantity/total from the current `order_items` rows.
 * The SOLE writer of the header product mirror after creation — anything that mutates lines must
 * call this so the header never desyncs from the basket. Runs on the given client (inside a txn).
 * A commissionable order's `commission_amount` is re-derived as 5% of the new summed total so a
 * draft quantity edit can never leave the stored commission stale against the header total (only
 * draft orders are line-editable, so billed/paid rows are never touched by this path).
 */
export async function recomputeOrderHeaderFromItems(
  orderId: string,
  tenantId: string,
  client: PoolClient | typeof pool = pool,
): Promise<void> {
  await client.query(
    `WITH primary_line AS (
       SELECT product_id, product_name, unit_price
       FROM order_items
       WHERE order_id = $1
       ORDER BY total_price DESC, item_index ASC
       LIMIT 1
     ),
     agg AS (
       SELECT COALESCE(SUM(quantity), 0) AS q_sum, COALESCE(SUM(total_price), 0) AS t_sum
       FROM order_items WHERE order_id = $1
     )
     UPDATE orders o
     SET product_id   = (SELECT product_id FROM primary_line),
         product_name = COALESCE((SELECT product_name FROM primary_line), o.product_name),
         unit_price   = COALESCE((SELECT unit_price FROM primary_line), o.unit_price),
         quantity     = GREATEST((SELECT q_sum FROM agg), 1),
         total_price  = (SELECT t_sum FROM agg),
         commission_amount = CASE
           WHEN o.is_commissionable THEN ROUND((SELECT t_sum FROM agg) * 0.05, 2)
           ELSE o.commission_amount
         END,
         updated_at   = now()
     WHERE o.id = $1 AND o.tenant_id = $2`,
    [orderId, tenantId],
  );
}

const ORDER_SORT_SQL: Record<OrderListSortColumn, string> = {
  created_at: 'o.created_at',
  customer_name: 'o.customer_name',
  total_price: 'o.total_price',
  quantity: 'o.quantity',
  status: 'o.status',
};

export async function listOrdersForTenant(filters: OrderListFilters): Promise<{
  orders: OrderListItem[];
  total: number;
}> {
  const page = filters.page ?? 1;
  const limit = filters.limit ?? 20;
  const offset = (page - 1) * limit;

  const conditions: string[] = ['o.tenant_id = $1'];
  const values: unknown[] = [filters.tenantId];
  let paramIdx = 2;

  if (filters.status) {
    conditions.push(`o.status = $${paramIdx}`);
    values.push(filters.status);
    paramIdx++;
  }

  if (filters.conversationId) {
    conditions.push(`o.conversation_id = $${paramIdx}`);
    values.push(filters.conversationId);
    paramIdx++;
  }

  if (filters.search?.trim()) {
    conditions.push(`o.customer_name ILIKE $${paramIdx}`);
    values.push(`%${filters.search.trim()}%`);
    paramIdx++;
  }

  if (filters.createdFrom) {
    conditions.push(`o.created_at >= $${paramIdx}`);
    values.push(filters.createdFrom);
    paramIdx++;
  }

  if (filters.createdTo) {
    conditions.push(`o.created_at <= $${paramIdx}`);
    values.push(filters.createdTo);
    paramIdx++;
  }

  const where = conditions.join(' AND ');
  const sortCol = ORDER_SORT_SQL[filters.sortBy ?? 'created_at'] ?? ORDER_SORT_SQL.created_at;
  const sortDir = filters.sortDir === 'asc' ? 'ASC' : 'DESC';

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM orders o
     INNER JOIN conversations conv ON conv.id = o.conversation_id AND conv.tenant_id = o.tenant_id
     LEFT JOIN channels ch ON ch.id = conv.channel_id AND ch.tenant_id = o.tenant_id
     WHERE ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  type Row = OrderRow & { channel_type: ChannelType | null };

  const { rows } = await pool.query<Row>(
    `SELECT o.*, ch.type AS channel_type
     FROM orders o
     INNER JOIN conversations conv ON conv.id = o.conversation_id AND conv.tenant_id = o.tenant_id
     LEFT JOIN channels ch ON ch.id = conv.channel_id AND ch.tenant_id = o.tenant_id
     WHERE ${where}
     ORDER BY ${sortCol} ${sortDir}
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset],
  );

  const itemsByOrder = await listOrderItemsForOrders(filters.tenantId, rows.map((r) => r.id));
  return {
    orders: rows.map((r) => {
      const { channel_type, ...rest } = r;
      return {
        ...rowToOrder(rest, itemsByOrder.get(r.id) ?? []),
        channel_type: channel_type ?? 'facebook',
      };
    }),
    total,
  };
}

export async function findOrderByIdForTenant(
  id: string,
  tenantId: string,
): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    'SELECT * FROM orders WHERE id = $1 AND tenant_id = $2',
    [id, tenantId],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

export async function findOrderWithRelationsForTenant(
  id: string,
  tenantId: string,
): Promise<OrderWithRelations | null> {
  const order = await findOrderByIdForTenant(id, tenantId);
  if (!order) return null;

  const [conversation, contact, items] = await Promise.all([
    findConversationByIdForTenant(order.conversation_id, tenantId),
    findContactById(order.contact_id),
    listOrderItemsForOrder(tenantId, order.id),
  ]);

  if (!conversation || !contact || contact.tenant_id !== tenantId) {
    return null;
  }

  // channel_id may be null when the social account was disconnected after the order was created
  const channel = conversation.channel_id
    ? await findChannelById(conversation.channel_id, tenantId)
    : null;

  return {
    ...order,
    items,
    conversation,
    contact,
    channel: channel
      ? { id: channel.id, type: channel.type, name: channel.name }
      : { id: '', type: 'facebook' as const, name: 'Disconnected channel' },
  };
}

export async function updateOrderStatusForTenant(
  id: string,
  tenantId: string,
  status: OrderStatus,
  client: PoolClient | typeof pool = pool,
): Promise<Order | null> {
  const { rows } = await client.query<OrderRow>(
    `UPDATE orders SET status = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, status],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

/**
 * Latest order for a contact that may still need cancel/refund handling.
 * Includes draft through delivered; excludes terminal cancelled/refunded rows.
 */
export async function findLatestOpenOrderForContactForEscalation(
  tenantId: string,
  contactId: string,
): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT *
     FROM orders
     WHERE tenant_id = $1
       AND contact_id = $2
       AND status NOT IN ('cancelled', 'refunded')
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, contactId],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

export async function markOrderCancellationRequested(
  orderId: string,
  tenantId: string,
  reason: string | null,
): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders
     SET cancellation_requested_at = now(),
         cancellation_reason = COALESCE($3, cancellation_reason),
         resolution_status = 'pending',
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [orderId, tenantId, reason],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

export async function markOrderRefundRequested(
  orderId: string,
  tenantId: string,
  reason: string | null,
): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders
     SET refund_requested_at = now(),
         refund_reason = COALESCE($3, refund_reason),
         resolution_status = 'pending',
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [orderId, tenantId, reason],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

type ActionRequiredOrderRow = OrderRow & {
  contact_name: string;
  channel_type: ChannelType | null;
  request_reason: string | null;
};

export async function listActionRequiredOrdersForTenant(
  tenantId: string,
): Promise<ActionRequiredOrder[]> {
  const { rows } = await pool.query<ActionRequiredOrderRow>(
    `SELECT
       o.*,
       ct.name AS contact_name,
       ch.type AS channel_type,
       COALESCE(o.cancellation_reason, o.refund_reason) AS request_reason
     FROM orders o
     INNER JOIN contacts ct ON ct.id = o.contact_id AND ct.tenant_id = o.tenant_id
     INNER JOIN conversations conv ON conv.id = o.conversation_id AND conv.tenant_id = o.tenant_id
     LEFT JOIN channels ch ON ch.id = conv.channel_id AND ch.tenant_id = o.tenant_id
     WHERE o.tenant_id = $1
       AND (o.cancellation_requested_at IS NOT NULL OR o.refund_requested_at IS NOT NULL)
       AND (o.resolution_status IS NULL OR o.resolution_status = 'pending')
     ORDER BY GREATEST(
       COALESCE(o.cancellation_requested_at, '-infinity'::timestamptz),
       COALESCE(o.refund_requested_at, '-infinity'::timestamptz)
     ) DESC`,
    [tenantId],
  );

  const itemsByOrder = await listOrderItemsForOrders(tenantId, rows.map((r) => r.id));
  return rows.map((row) => {
    const { contact_name, channel_type, request_reason, ...rest } = row;
    return {
      ...rowToOrder(rest, itemsByOrder.get(row.id) ?? []),
      contact_name,
      channel_type: channel_type ?? 'facebook',
      conversation_id: rest.conversation_id,
      request_reason,
    };
  });
}

export async function resolveOrderActionForTenant(
  orderId: string,
  tenantId: string,
  input: ResolveOrderActionInput,
): Promise<Order | null> {
  const current = await findOrderByIdForTenant(orderId, tenantId);
  if (!current) return null;

  let nextOrderStatus: OrderStatus | null = null;
  if (input.resolution_status === 'approved') {
    const cancellationAt = current.cancellation_requested_at?.getTime() ?? null;
    const refundAt = current.refund_requested_at?.getTime() ?? null;
    if (refundAt !== null && (cancellationAt === null || refundAt >= cancellationAt)) {
      nextOrderStatus = 'refunded';
    } else if (cancellationAt !== null) {
      nextOrderStatus = 'cancelled';
    }
  }

  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders
     SET resolution_status = $3,
         resolution_notes = $4,
         status = COALESCE($5, status),
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [orderId, tenantId, input.resolution_status, input.resolution_notes, nextOrderStatus],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

/**
 * Confirms an order and, when applicable:
 * - marks the conversation as fully AI-handled
 * - voids any unbilled AI use case for the conversation (order commission takes precedence)
 */
export async function confirmOrderForTenant(id: string, tenantId: string): Promise<Order | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<OrderRow>(
      `UPDATE orders
       SET status = 'confirmed', updated_at = now()
       WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('confirmed', 'cancelled')
       RETURNING *`,
      [id, tenantId],
    );

    const row = rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }

    if (row.is_commissionable) {
      await setConversationFullyAiHandled(row.conversation_id, tenantId, client);
    }

    // If an AI use case was recorded for this conversation before the order was confirmed,
    // void it — commission applies instead, never both.
    await client.query(
      `UPDATE ai_use_cases
       SET status = 'voided', updated_at = now()
       WHERE conversation_id = $1
         AND status = 'completed'
         AND billing_status = 'unbilled'`,
      [row.conversation_id],
    );

    await client.query('COMMIT');
    return rowToOrder(row);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface AiOrderListRow {
  id: string;
  conversation_id: string;
  contact_id: string;
  contact_name: string;
  product_name: string;
  total_price: number;
  commission_amount: number;
  commission_status: CommissionStatus;
  status: OrderStatus;
  created_at: Date;
}

/**
 * Returns a paginated list of commissionable (AI-created) orders for a tenant, newest first.
 * Used by the tenant Credits page to show AI orders commission history.
 */
export async function listAiOrdersForTenant(
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ rows: AiOrderListRow[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM orders
     WHERE tenant_id = $1
       AND is_commissionable = true`,
    [tenantId],
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  type Row = {
    id: string;
    conversation_id: string;
    contact_id: string;
    contact_name: string;
    product_name: string;
    total_price: string | number;
    commission_amount: string | number;
    commission_status: CommissionStatus;
    status: OrderStatus;
    created_at: Date;
  };

  const { rows } = await pool.query<Row>(
    `SELECT
       o.id,
       o.conversation_id,
       o.contact_id,
       COALESCE(ct.name, 'Unknown') AS contact_name,
       o.product_name,
       o.total_price,
       o.commission_amount,
       o.commission_status,
       o.status,
       o.created_at
     FROM orders o
     LEFT JOIN contacts ct ON ct.id = o.contact_id
     WHERE o.tenant_id = $1
       AND o.is_commissionable = true
     ORDER BY o.created_at DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset],
  );

  return {
    rows: rows.map((r) => ({
      id: r.id,
      conversation_id: r.conversation_id,
      contact_id: r.contact_id,
      contact_name: r.contact_name,
      product_name: r.product_name,
      total_price: Number(r.total_price),
      commission_amount: Number(r.commission_amount),
      commission_status: r.commission_status,
      status: r.status,
      created_at: r.created_at,
    })),
    total,
  };
}

export async function findOrderById(id: string): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>('SELECT * FROM orders WHERE id = $1 LIMIT 1', [id]);
  return rows[0] ? rowToOrder(rows[0]) : null;
}

/**
 * Most recent non-cancelled order in the conversation.
 * Used by AI order intent flow to prevent duplicate re-creation spam.
 */
export async function findLatestActiveOrderForConversation(
  tenantId: string,
  conversationId: string,
): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `SELECT *
     FROM orders
     WHERE tenant_id = $1
       AND conversation_id = $2
       AND status <> 'cancelled'
     ORDER BY created_at DESC
     LIMIT 1`,
    [tenantId, conversationId],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

export async function updateOrderCommissionStatusById(
  orderId: string,
  commissionStatus: CommissionStatus,
): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders
     SET commission_status = $2, updated_at = now()
     WHERE id = $1 AND is_commissionable = true
     RETURNING *`,
    [orderId, commissionStatus],
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

const COMMISSIONABLE_ORDER_STATUSES_SQL = "('confirmed', 'processing', 'shipped', 'delivered')";

export async function markOrdersCommissionBilledInPeriod(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  const result = await client.query(
    `UPDATE orders
     SET commission_status = 'billed', updated_at = now()
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND commission_status = 'unpaid'
       AND status IN ${COMMISSIONABLE_ORDER_STATUSES_SQL}
       AND created_at >= $2::timestamptz
       AND created_at < $3::timestamptz`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  return result.rowCount ?? 0;
}

export async function markOrdersCommissionPaidInPeriod(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  const result = await client.query(
    `UPDATE orders
     SET commission_status = 'paid', updated_at = now()
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND commission_status IN ('unpaid', 'billed')
       AND status IN ${COMMISSIONABLE_ORDER_STATUSES_SQL}
       AND created_at >= $2::timestamptz
       AND created_at < $3::timestamptz`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  return result.rowCount ?? 0;
}

export async function markOrdersCommissionUnpaidInPeriod(
  tenantId: string,
  rangeStartInclusive: Date,
  rangeEndExclusive: Date,
  client: PoolClient | typeof pool = pool,
): Promise<number> {
  const result = await client.query(
    `UPDATE orders
     SET commission_status = 'unpaid', updated_at = now()
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND commission_status IN ('billed', 'paid')
       AND status IN ${COMMISSIONABLE_ORDER_STATUSES_SQL}
       AND created_at >= $2::timestamptz
       AND created_at < $3::timestamptz`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  return result.rowCount ?? 0;
}

/**
 * Updates customer-supplied order information for any non-terminal order.
 * Called by the AI reply pipeline when a customer asks to correct their
 * delivery address, phone number, name, or delivery notes after placing an order.
 * Unlike updateDraftOrderForTenant, this works across all statuses except
 * 'cancelled' and 'refunded', and does not recalculate total_price.
 */
export async function updateOrderCustomerInfoForAI(
  id: string,
  tenantId: string,
  fields: UpdateOrderCustomerInfoInput,
): Promise<Order | null> {
  const keys = Object.keys(fields) as (keyof UpdateOrderCustomerInfoInput)[];
  if (keys.length === 0) return findOrderByIdForTenant(id, tenantId);

  const setClauses: string[] = [];
  const values: unknown[] = [id, tenantId];
  let paramIdx = 3;

  for (const key of keys) {
    setClauses.push(`${key} = $${paramIdx}`);
    values.push(fields[key]);
    paramIdx++;
  }
  setClauses.push('updated_at = now()');

  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders
     SET ${setClauses.join(', ')}
     WHERE id = $1
       AND tenant_id = $2
       AND status NOT IN ('cancelled', 'refunded')
     RETURNING *`,
    values,
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
}

export async function updateDraftOrderForTenant(
  id: string,
  tenantId: string,
  fields: UpdateDraftOrderInput,
): Promise<Order | null> {
  const keys = Object.keys(fields) as (keyof UpdateDraftOrderInput)[];
  if (keys.length === 0) {
    return findOrderByIdForTenant(id, tenantId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Only draft orders are editable; lock the row so the header recompute stays consistent.
    const { rows: guard } = await client.query<{ id: string }>(
      `SELECT id FROM orders WHERE id = $1 AND tenant_id = $2 AND status = 'draft' FOR UPDATE`,
      [id, tenantId],
    );
    if (!guard[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    // Header-only fields (delivery_address, notes) update the orders row directly.
    const headerSet: string[] = [];
    const headerVals: unknown[] = [id, tenantId];
    let p = 3;
    for (const key of ['delivery_address', 'notes'] as const) {
      if (key in fields) {
        headerSet.push(`${key} = $${p}`);
        headerVals.push(fields[key]);
        p++;
      }
    }
    if (headerSet.length > 0) {
      headerSet.push('updated_at = now()');
      await client.query(
        `UPDATE orders SET ${headerSet.join(', ')} WHERE id = $1 AND tenant_id = $2`,
        headerVals,
      );
    }

    // A quantity edit applies to the PRIMARY line (highest line total); the header quantity/total
    // are then re-derived from the lines. For a single-line order this is identical to the legacy
    // `total_price = unit_price * quantity` recompute.
    if (fields.quantity != null) {
      const qty = Math.max(1, Math.floor(fields.quantity));
      await client.query(
        // $3::int in both slots so Postgres deduces one consistent type — bare $3 is inferred
        // integer from `quantity = $3` but numeric from `unit_price * $3`, which errors (42P08).
        `UPDATE order_items
         SET quantity = $3::int, total_price = ROUND(unit_price * $3::int, 2), updated_at = now()
         WHERE id = (
           SELECT id FROM order_items WHERE order_id = $1 AND tenant_id = $2
           ORDER BY total_price DESC, item_index ASC LIMIT 1
         )`,
        [id, tenantId, qty],
      );
    }

    await recomputeOrderHeaderFromItems(id, tenantId, client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const order = await findOrderByIdForTenant(id, tenantId);
  if (!order) return null;
  return { ...order, items: await listOrderItemsForOrder(tenantId, id) };
}

export type OrderWithChannelType = Order & { channel_type: ChannelType };

export async function listOrdersForContactForTenant(
  contactId: string,
  tenantId: string,
  page: number,
  limit: number,
): Promise<{ orders: OrderWithChannelType[]; total: number }> {
  const offset = (page - 1) * limit;

  const countResult = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
     FROM orders o
     WHERE o.contact_id = $1 AND o.tenant_id = $2`,
    [contactId, tenantId],
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  type Row = OrderRow & { channel_type: ChannelType | null };
  const { rows } = await pool.query<Row>(
    `SELECT o.*, ch.type AS channel_type
     FROM orders o
     INNER JOIN conversations conv ON conv.id = o.conversation_id AND conv.tenant_id = o.tenant_id
     LEFT JOIN channels ch ON ch.id = conv.channel_id AND ch.tenant_id = o.tenant_id
     WHERE o.contact_id = $1 AND o.tenant_id = $2
     ORDER BY o.created_at DESC
     LIMIT $3 OFFSET $4`,
    [contactId, tenantId, limit, offset],
  );

  const itemsByOrder = await listOrderItemsForOrders(tenantId, rows.map((r) => r.id));
  return {
    orders: rows.map((r) => {
      const { channel_type, ...rest } = r;
      return {
        ...rowToOrder(rest, itemsByOrder.get(r.id) ?? []),
        channel_type: channel_type ?? 'facebook',
      };
    }),
    total,
  };
}
