import type { OrderStatus } from '@/types/order';

export interface OrderTimelineEntry {
  key: string;
  label: string;
  at: string;
}

/**
 * Infers milestone labels from the current status (no persisted history yet).
 * Timestamps after "draft" use `updated_at` as an approximation of the last transition.
 */
export function buildInferredOrderTimeline(
  status: OrderStatus,
  createdAt: string,
  updatedAt: string,
): OrderTimelineEntry[] {
  const items: OrderTimelineEntry[] = [
    { key: 'draft', label: 'Draft order created', at: createdAt },
  ];

  if (status === 'cancelled') {
    items.push({ key: 'cancelled', label: 'Order cancelled', at: updatedAt });
    return items;
  }

  const rank: Record<OrderStatus, number> = {
    draft: 0,
    confirmed: 1,
    processing: 2,
    shipped: 3,
    delivered: 4,
    cancelled: 0,
  };

  const r = rank[status] ?? 0;
  if (r >= 1) items.push({ key: 'confirmed', label: 'Order confirmed', at: updatedAt });
  if (r >= 2) items.push({ key: 'processing', label: 'Processing', at: updatedAt });
  if (r >= 3) items.push({ key: 'shipped', label: 'Shipped', at: updatedAt });
  if (r >= 4) items.push({ key: 'delivered', label: 'Delivered', at: updatedAt });

  return items;
}
