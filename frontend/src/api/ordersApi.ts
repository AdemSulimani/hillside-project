import api from '@/lib/api';
import type { PaginatedResponse } from '@/types';
import type { ChannelType } from '@/types/conversation';
import type {
  ActionRequiredOrder,
  OrderListItem,
  OrderResolutionStatus,
  OrderStatus,
  OrderWithRelations,
} from '@/types/order';

function toNum(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toInt(v: unknown): number {
  const n = toNum(v);
  return Math.floor(n);
}

export function normalizeOrderListItem(raw: Record<string, unknown>): OrderListItem {
  return {
    id: String(raw.id),
    tenant_id: String(raw.tenant_id),
    conversation_id: String(raw.conversation_id),
    contact_id: String(raw.contact_id),
    product_id: raw.product_id != null ? String(raw.product_id) : null,
    product_name: String(raw.product_name ?? ''),
    quantity: toInt(raw.quantity) || 1,
    unit_price: toNum(raw.unit_price),
    total_price: toNum(raw.total_price),
    status: (raw.status as OrderStatus) ?? 'draft',
    customer_name: String(raw.customer_name ?? ''),
    customer_phone: raw.customer_phone != null ? String(raw.customer_phone) : null,
    delivery_address: raw.delivery_address != null ? String(raw.delivery_address) : null,
    notes: raw.notes != null ? String(raw.notes) : null,
    detected_by: String(raw.detected_by ?? 'ai'),
    cancellation_reason: raw.cancellation_reason != null ? String(raw.cancellation_reason) : null,
    refund_reason: raw.refund_reason != null ? String(raw.refund_reason) : null,
    cancellation_requested_at:
      raw.cancellation_requested_at != null ? String(raw.cancellation_requested_at) : null,
    refund_requested_at: raw.refund_requested_at != null ? String(raw.refund_requested_at) : null,
    resolution_status:
      raw.resolution_status != null ? String(raw.resolution_status) as OrderListItem['resolution_status'] : null,
    resolution_notes: raw.resolution_notes != null ? String(raw.resolution_notes) : null,
    created_at: String(raw.created_at ?? ''),
    updated_at: String(raw.updated_at ?? ''),
    channel_type: (raw.channel_type as ChannelType) ?? 'whatsapp',
  };
}

type OrdersListJson = {
  success: boolean;
  data: Record<string, unknown>[];
  pagination: PaginatedResponse<unknown>['pagination'];
  message?: string;
};

export type OrderListParams = {
  page?: number;
  limit?: number;
  status?: OrderStatus;
  conversation_id?: string;
  search?: string;
  created_from?: string;
  created_to?: string;
  sort?: 'created_at' | 'customer_name' | 'total_price' | 'quantity' | 'status';
  sort_dir?: 'asc' | 'desc';
};

export async function fetchOrders(params: OrderListParams): Promise<{
  orders: OrderListItem[];
  pagination: PaginatedResponse<OrderListItem>['pagination'];
}> {
  const { data } = await api.get<OrdersListJson>('/orders', {
    params: {
      page: params.page ?? 1,
      limit: params.limit ?? 20,
      status: params.status,
      conversation_id: params.conversation_id,
      search: params.search?.trim() || undefined,
      created_from: params.created_from,
      created_to: params.created_to,
      sort: params.sort,
      sort_dir: params.sort_dir ?? 'desc',
    },
  });

  const orders = (data.data ?? []).map((row) => normalizeOrderListItem(row));
  return { orders, pagination: data.pagination };
}

function normalizeOrderCore(raw: Record<string, unknown>): Omit<OrderListItem, 'channel_type'> {
  const ch = raw.channel as Record<string, unknown> | undefined;
  const fallbackType = (ch?.type as ChannelType) ?? 'whatsapp';
  const full = normalizeOrderListItem({ ...raw, channel_type: fallbackType });
  const core = { ...full } as Omit<OrderListItem, 'channel_type'> & { channel_type?: ChannelType };
  delete core.channel_type;
  return core;
}

function normalizeOrderWithRelations(raw: Record<string, unknown>): OrderWithRelations {
  const core = normalizeOrderCore(raw);

  const conv = raw.conversation as Record<string, unknown> | undefined;
  const contact = raw.contact as Record<string, unknown> | undefined;
  const channel = raw.channel as Record<string, unknown> | undefined;

  if (!conv || !contact || !channel) {
    throw new Error('Invalid order detail payload');
  }

  return {
    ...core,
    conversation: {
      id: String(conv.id),
      tenant_id: String(conv.tenant_id),
      contact_id: String(conv.contact_id),
      channel_id: String(conv.channel_id),
      status: String(conv.status ?? ''),
      last_message_at: String(conv.last_message_at ?? ''),
      human_override_until:
        conv.human_override_until != null ? String(conv.human_override_until) : null,
      created_at: String(conv.created_at ?? ''),
      updated_at: String(conv.updated_at ?? ''),
    },
    contact: {
      id: String(contact.id),
      tenant_id: String(contact.tenant_id),
      channel_id: String(contact.channel_id),
      external_id: String(contact.external_id ?? ''),
      name: String(contact.name ?? ''),
      avatar_url: contact.avatar_url != null ? String(contact.avatar_url) : null,
      metadata:
        contact.metadata && typeof contact.metadata === 'object' && !Array.isArray(contact.metadata)
          ? (contact.metadata as Record<string, unknown>)
          : {},
      created_at: String(contact.created_at ?? ''),
      updated_at: String(contact.updated_at ?? ''),
    },
    channel: {
      id: String(channel.id),
      type: (channel.type as ChannelType) ?? 'whatsapp',
      name: String(channel.name ?? ''),
    },
  };
}

type OrderDetailJson = {
  success: boolean;
  data: { order: Record<string, unknown> };
  message?: string;
};

export async function fetchOrderById(id: string): Promise<OrderWithRelations> {
  const { data } = await api.get<OrderDetailJson>(`/orders/${id}`);
  const order = data.data?.order;
  if (!order || typeof order !== 'object') {
    throw new Error('Order not found');
  }
  return normalizeOrderWithRelations(order);
}

export async function updateDraftOrder(
  id: string,
  body: {
    quantity?: number;
    delivery_address?: string | null;
    notes?: string | null;
  },
): Promise<Omit<OrderListItem, 'channel_type'>> {
  const { data } = await api.put<{ success: boolean; data: { order: Record<string, unknown> } }>(
    `/orders/${id}`,
    body,
  );
  const row = data.data?.order;
  if (!row) throw new Error('Update failed');
  return normalizeOrderCore(row);
}

export async function confirmOrder(id: string): Promise<Omit<OrderListItem, 'channel_type'>> {
  const { data } = await api.patch<{ success: boolean; data: { order: Record<string, unknown> } }>(
    `/orders/${id}/confirm`,
  );
  const row = data.data?.order;
  if (!row) throw new Error('Confirm failed');
  return normalizeOrderCore(row);
}

export async function cancelOrder(id: string): Promise<Omit<OrderListItem, 'channel_type'>> {
  const { data } = await api.patch<{ success: boolean; data: { order: Record<string, unknown> } }>(
    `/orders/${id}/cancel`,
  );
  const row = data.data?.order;
  if (!row) throw new Error('Cancel failed');
  return normalizeOrderCore(row);
}

export function normalizeActionRequiredOrder(raw: Record<string, unknown>): ActionRequiredOrder {
  const base = normalizeOrderListItem(raw);
  return {
    ...base,
    contact_name: String(raw.contact_name ?? base.customer_name ?? ''),
    request_reason: raw.request_reason != null ? String(raw.request_reason) : null,
  };
}

export async function fetchActionRequiredOrders(): Promise<ActionRequiredOrder[]> {
  const { data } = await api.get<{ success: boolean; data: { orders: Record<string, unknown>[] } }>(
    '/orders/action-required',
  );
  const rows = data.data?.orders ?? [];
  return rows.map((row) => normalizeActionRequiredOrder(row));
}

export async function resolveOrderAction(
  orderId: string,
  payload: {
    resolution_status: Exclude<OrderResolutionStatus, 'pending'>;
    resolution_notes: string;
    resume_ai?: boolean;
  },
): Promise<Omit<OrderListItem, 'channel_type'>> {
  const { data } = await api.patch<{ success: boolean; data: { order: Record<string, unknown> } }>(
    `/orders/${orderId}/resolve`,
    payload,
  );
  const row = data.data?.order;
  if (!row) throw new Error('Resolve failed');
  return normalizeOrderCore(row);
}

export async function sendOrderResolutionMessage(
  orderId: string,
  payload: { message: string },
): Promise<void> {
  await api.post(`/orders/${orderId}/send-resolution-message`, payload);
}
