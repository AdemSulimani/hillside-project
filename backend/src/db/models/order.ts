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
    channel_id: string;
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
    channel_id: string;
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

type OrderRow = Omit<Order, 'unit_price' | 'total_price' | 'commission_amount'> & {
  unit_price: string | number;
  total_price: string | number;
  commission_amount: string | number | null;
};

function rowToOrder(row: OrderRow): Order {
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
  };
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const qty = input.quantity ?? 1;
  const isCommissionable = input.is_commissionable ?? false;
  const commissionAmount = input.commission_amount ?? null;
  const commissionStatus = input.commission_status ?? 'unpaid';
  const { rows } = await pool.query<OrderRow>(
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
      input.product_id ?? null,
      input.product_name,
      qty,
      input.unit_price,
      input.total_price,
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
  return rowToOrder(rows[0]);
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

  return {
    orders: rows.map((r) => {
      const { channel_type, ...rest } = r;
      return { ...rowToOrder(rest), channel_type };
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

  const [conversation, contact] = await Promise.all([
    findConversationByIdForTenant(order.conversation_id, tenantId),
    findContactById(order.contact_id),
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
  channel_type: ChannelType;
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

  return rows.map((row) => {
    const { contact_name, channel_type, request_reason, ...rest } = row;
    return {
      ...rowToOrder(rest),
      contact_name,
      channel_type,
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
): Promise<number> {
  const result = await pool.query(
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
): Promise<number> {
  const result = await pool.query(
    `UPDATE orders
     SET commission_status = 'paid', updated_at = now()
     WHERE tenant_id = $1
       AND is_commissionable = true
       AND commission_status = 'billed'
       AND status IN ${COMMISSIONABLE_ORDER_STATUSES_SQL}
       AND created_at >= $2::timestamptz
       AND created_at < $3::timestamptz`,
    [tenantId, rangeStartInclusive, rangeEndExclusive],
  );
  return result.rowCount ?? 0;
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

  const setClauses: string[] = [];
  const values: unknown[] = [id, tenantId];
  let paramIdx = 3;

  for (const key of keys) {
    setClauses.push(`${key} = $${paramIdx}`);
    values.push(fields[key]);
    paramIdx++;
  }
  setClauses.push('updated_at = now()');
  setClauses.push(`total_price = unit_price * quantity`);

  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET ${setClauses.join(', ')}
     WHERE id = $1 AND tenant_id = $2 AND status = 'draft'
     RETURNING *`,
    values,
  );
  return rows[0] ? rowToOrder(rows[0]) : null;
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

  return {
    orders: rows.map((r) => {
      const { channel_type, ...rest } = r;
      return { ...rowToOrder(rest), channel_type };
    }),
    total,
  };
}
