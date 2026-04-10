import pool from '../pool';
import { findConversationByIdForTenant } from './conversation';
import { findContactById } from './contact';
import { findChannelById, type Channel, type ChannelType } from './channel';

export type OrderStatus =
  | 'draft'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled';

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

export interface UpdateDraftOrderInput {
  quantity?: number;
  delivery_address?: string | null;
  notes?: string | null;
}

type OrderRow = Omit<Order, 'unit_price' | 'total_price'> & {
  unit_price: string | number;
  total_price: string | number;
};

function rowToOrder(row: OrderRow): Order {
  return {
    ...row,
    unit_price: Number(row.unit_price),
    total_price: Number(row.total_price),
  };
}

export async function createOrder(input: CreateOrderInput): Promise<Order> {
  const qty = input.quantity ?? 1;
  const { rows } = await pool.query<OrderRow>(
    `INSERT INTO orders (
      tenant_id, conversation_id, contact_id, product_id, product_name, quantity,
      unit_price, total_price, status, customer_name, customer_phone, delivery_address, notes, detected_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
     INNER JOIN channels ch ON ch.id = conv.channel_id AND ch.tenant_id = o.tenant_id
     WHERE ${where}`,
    values,
  );
  const total = parseInt(countResult.rows[0].count, 10);

  type Row = OrderRow & { channel_type: ChannelType };

  const { rows } = await pool.query<Row>(
    `SELECT o.*, ch.type AS channel_type
     FROM orders o
     INNER JOIN conversations conv ON conv.id = o.conversation_id AND conv.tenant_id = o.tenant_id
     INNER JOIN channels ch ON ch.id = conv.channel_id AND ch.tenant_id = o.tenant_id
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

  const channel = await findChannelById(conversation.channel_id, tenantId);
  if (!channel) {
    return null;
  }

  return {
    ...order,
    conversation,
    contact,
    channel: { id: channel.id, type: channel.type, name: channel.name },
  };
}

export async function updateOrderStatusForTenant(
  id: string,
  tenantId: string,
  status: OrderStatus,
): Promise<Order | null> {
  const { rows } = await pool.query<OrderRow>(
    `UPDATE orders SET status = $3, updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [id, tenantId, status],
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

  type Row = OrderRow & { channel_type: ChannelType };
  const { rows } = await pool.query<Row>(
    `SELECT o.*, ch.type AS channel_type
     FROM orders o
     INNER JOIN conversations conv ON conv.id = o.conversation_id AND conv.tenant_id = o.tenant_id
     INNER JOIN channels ch ON ch.id = conv.channel_id AND ch.tenant_id = o.tenant_id
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
