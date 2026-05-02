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
    { key: 'draft', label: 'Porosi skicë e krijuar', at: createdAt },
  ];

  if (status === 'cancelled') {
    items.push({ key: 'cancelled', label: 'Porosia u anulua', at: updatedAt });
    return items;
  }
  if (status === 'refunded') {
    items.push({ key: 'refunded', label: 'Porosia u rimbursua', at: updatedAt });
    return items;
  }

  const rank: Record<OrderStatus, number> = {
    draft: 0,
    confirmed: 1,
    processing: 2,
    shipped: 3,
    delivered: 4,
    cancelled: 0,
    refunded: 0,
  };

  const r = rank[status] ?? 0;
  if (r >= 1) items.push({ key: 'confirmed', label: 'Porosia u konfirmua', at: updatedAt });
  if (r >= 2) items.push({ key: 'processing', label: 'Në përpunim', at: updatedAt });
  if (r >= 3) items.push({ key: 'shipped', label: 'E dërguar', at: updatedAt });
  if (r >= 4) items.push({ key: 'delivered', label: 'E dorëzuar', at: updatedAt });

  return items;
}
