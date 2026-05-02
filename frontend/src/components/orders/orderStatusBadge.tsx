import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { OrderStatus } from '@/types/order';

const styles: Record<OrderStatus, string> = {
  draft: 'bg-amber-500/15 text-amber-900 dark:text-amber-100 border-amber-500/30',
  confirmed: 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 border-emerald-500/30',
  processing: 'bg-sky-500/15 text-sky-900 dark:text-sky-100 border-sky-500/30',
  shipped: 'bg-violet-500/15 text-violet-900 dark:text-violet-100 border-violet-500/30',
  delivered: 'bg-muted text-foreground border-border',
  cancelled: 'bg-destructive/10 text-destructive border-destructive/30',
  refunded: 'bg-rose-500/10 text-rose-700 dark:text-rose-200 border-rose-500/30',
};

const labels: Record<OrderStatus, string> = {
  draft: 'Skicë',
  confirmed: 'E konfirmuar',
  processing: 'Në përpunim',
  shipped: 'E dërguar',
  delivered: 'E dorëzuar',
  cancelled: 'E anuluar',
  refunded: 'E rimbursuar',
};

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  return (
    <Badge variant="outline" className={cn('capitalize', styles[status])}>
      {labels[status]}
    </Badge>
  );
}
