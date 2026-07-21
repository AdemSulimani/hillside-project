import type { ChannelType } from '@/types/conversation';

export type OrderListSortColumn =
  | 'created_at'
  | 'customer_name'
  | 'total_price'
  | 'quantity'
  | 'status';

export type OrderStatus =
  | 'draft'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded';

export type OrderResolutionStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'store_credit_offered';

export interface OrderListItem {
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
  cancellation_reason: string | null;
  refund_reason: string | null;
  cancellation_requested_at: string | null;
  refund_requested_at: string | null;
  resolution_status: OrderResolutionStatus | null;
  resolution_notes: string | null;
  created_at: string;
  updated_at: string;
  channel_type: ChannelType;
}

export interface ActionRequiredOrder extends OrderListItem {
  contact_name: string;
  request_reason: string | null;
}

/** IA escalation row shown under Porositë → Veprim i nevojshëm (no order resolution form). */
export interface ActionTabAlertTask {
  id: string;
  conversation_id: string;
  reason: string;
  status: string;
  created_at: string;
  contact_name: string;
  channel_type: ChannelType;
  channel_name: string;
  message_content: string | null;
}

export interface OrderConversationSummary {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  status: string;
  last_message_at: string;
  human_override_until: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrderContactSummary {
  id: string;
  tenant_id: string;
  channel_id: string;
  external_id: string;
  name: string;
  avatar_url: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface OrderChannelSummary {
  id: string;
  type: ChannelType;
  name: string;
}

export interface OrderWithRelations extends Omit<OrderListItem, 'channel_type'> {
  conversation: OrderConversationSummary;
  contact: OrderContactSummary;
  channel: OrderChannelSummary;
}
