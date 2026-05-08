import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Loader2,
  MoreHorizontal,
  ShieldAlert,
  Search,
  ShoppingCart,
} from 'lucide-react';
import { resolveAIAlert } from '@/api/aiAlertsApi';
import {
  fetchActionRequiredOrders,
  fetchOrders,
  resolveOrderAction,
  sendOrderResolutionMessage,
} from '@/api/ordersApi';
import { OrderDetailDrawer } from '@/components/orders/OrderDetailDrawer';
import { orderChannelIcon } from '@/components/orders/orderChannelIcon';
import { OrderStatusBadge } from '@/components/orders/orderStatusBadge';
import { formatFlagReason } from '@/lib/aiAlertLabels';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/app';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { OrderListSortColumn, OrderResolutionStatus, OrderStatus } from '@/types/order';
import { Button, buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

const PAGE_SIZE = 20;

type OrdersTabKey = 'all' | OrderStatus | 'action_required';

const STATUS_TABS: { key: OrdersTabKey; label: string; filter?: OrderStatus }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft', filter: 'draft' },
  { key: 'confirmed', label: 'Confirmed', filter: 'confirmed' },
  { key: 'processing', label: 'Processing', filter: 'processing' },
  { key: 'shipped', label: 'Shipped', filter: 'shipped' },
  { key: 'delivered', label: 'Delivered', filter: 'delivered' },
  { key: 'cancelled', label: 'Cancelled', filter: 'cancelled' },
  { key: 'refunded', label: 'Refunded', filter: 'refunded' },
  { key: 'action_required', label: 'Action required' },
];

type ResolutionChoice = Exclude<OrderResolutionStatus, 'pending'>;

const RESOLUTION_OPTIONS: { value: ResolutionChoice; label: string }[] = [
  { value: 'approved', label: 'Approve' },
  { value: 'rejected', label: 'Reject' },
  { value: 'store_credit_offered', label: 'Offer store credit' },
];

interface ActionFormState {
  resolution_status: ResolutionChoice;
  resolution_notes: string;
  customer_message: string;
  resume_ai: boolean;
}

function startOfLocalDayIso(ymd: string): string | undefined {
  if (!ymd) return undefined;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

function endOfLocalDayIso(ymd: string): string | undefined {
  if (!ymd) return undefined;
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return undefined;
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
}

function renderOrderChannelIcon(channelType: Parameters<typeof orderChannelIcon>[0]) {
  const Icon = orderChannelIcon(channelType);
  return <Icon className="size-4 text-muted-foreground" />;
}

function SortHeader({
  label,
  column,
  activeColumn,
  direction,
  onSort,
}: {
  label: string;
  column: OrderListSortColumn;
  activeColumn: OrderListSortColumn;
  direction: 'asc' | 'desc';
  onSort: (col: OrderListSortColumn) => void;
}) {
  const active = activeColumn === column;
  return (
    <button
      type="button"
      onClick={() => onSort(column)}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
      className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
    >
      {label}
      {active ? (
        direction === 'asc' ? (
          <ArrowUp className="size-3.5 opacity-70" />
        ) : (
          <ArrowDown className="size-3.5 opacity-70" />
        )
      ) : (
        <ArrowUpDown className="size-3.5 opacity-40" />
      )}
    </button>
  );
}

export default function OrdersPage() {
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);
  const resetOrdersNavNewCount = useAppStore((s) => s.resetOrdersNavNewCount);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') === 'action_required' ? 'action_required' : 'all';

  const [statusTabState, setStatusTab] = useState<OrdersTabKey>(initialTab);
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<OrderListSortColumn>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const openFromQuery = searchParams.get('open');
  const initialDrawerOrderId =
    openFromQuery && /^[0-9a-f-]{36}$/i.test(openFromQuery) ? openFromQuery : null;
  const [drawerOrderId, setDrawerOrderId] = useState<string | null>(initialDrawerOrderId);
  const [drawerOpen, setDrawerOpen] = useState(Boolean(initialDrawerOrderId));
  const [actionForms, setActionForms] = useState<Record<string, ActionFormState>>({});

  useEffect(() => {
    resetOrdersNavNewCount();
  }, [resetOrdersNavNewCount]);

  useEffect(() => {
    if (!openFromQuery || !/^[0-9a-f-]{36}$/i.test(openFromQuery)) return;
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
  }, [openFromQuery, searchParams, setSearchParams]);

  const statusTab = useMemo<OrdersTabKey>(() => {
    const tabFromUrl = searchParams.get('tab') === 'action_required' ? 'action_required' : null;
    if (tabFromUrl === 'action_required') return 'action_required';
    if (statusTabState === 'action_required') return 'all';
    return statusTabState;
  }, [searchParams, statusTabState]);

  const statusFilter = useMemo(() => {
    const tab = STATUS_TABS.find((t) => t.key === statusTab);
    return tab?.filter;
  }, [statusTab]);

  const listQueryKey = useMemo(
    () =>
      [
        'orders',
        'list',
        tenantId,
        statusFilter,
        debouncedSearch,
        dateFrom,
        dateTo,
        page,
        sortColumn,
        sortDir,
      ] as const,
    [tenantId, statusFilter, debouncedSearch, dateFrom, dateTo, page, sortColumn, sortDir],
  );

  const { data, isLoading, isError, isFetching } = useQuery({
    queryKey: listQueryKey,
    queryFn: () =>
      fetchOrders({
        page,
        limit: PAGE_SIZE,
        status: statusFilter,
        search: debouncedSearch.trim() || undefined,
        created_from: startOfLocalDayIso(dateFrom),
        created_to: endOfLocalDayIso(dateTo),
        sort: sortColumn,
        sort_dir: sortDir,
      }),
    enabled: Boolean(tenantId) && statusTab !== 'action_required',
  });

  const actionRequiredQuery = useQuery({
    queryKey: ['orders', 'action-required', tenantId],
    queryFn: fetchActionRequiredOrders,
    enabled: Boolean(tenantId),
    refetchInterval: 30_000,
  });

  const resolveAlertTaskMutation = useMutation({
    mutationFn: (alertId: string) => resolveAIAlert(alertId, { resume_ai: false }),
    onSuccess: () => {
      toast.success('Alert closed');
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
    },
    onError: () => {
      toast.error('Could not close alert. Try from the AI Alerts page.');
    },
  });

  const sendResolutionMutation = useMutation({
    mutationFn: async (payload: {
      orderId: string;
      resolution_status: ResolutionChoice;
      resolution_notes: string;
      message: string;
      resume_ai: boolean;
    }) => {
      await resolveOrderAction(payload.orderId, {
        resolution_status: payload.resolution_status,
        resolution_notes: payload.resolution_notes,
        resume_ai: payload.resume_ai,
      });
      await sendOrderResolutionMessage(payload.orderId, {
        message: payload.message,
      });
    },
    onSuccess: () => {
      toast.success('Resolution sent to customer');
      void queryClient.invalidateQueries({ queryKey: ['orders'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts'] });
    },
    onError: () => {
      toast.error('Sending resolution failed. Please try again.');
    },
  });

  const orders = data?.orders ?? [];
  const actionRequiredOrders = actionRequiredQuery.data?.orders ?? [];
  const actionAlertTasks = actionRequiredQuery.data?.alert_tasks ?? [];
  const actionRequiredCount = actionRequiredOrders.length + actionAlertTasks.length;
  const pagination = data?.pagination;

  const handleSort = (col: OrderListSortColumn) => {
    if (sortColumn === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(col);
      setSortDir(col === 'customer_name' ? 'asc' : 'desc');
    }
    setPage(1);
  };

  const openDrawer = (id: string) => {
    setDrawerOrderId(id);
    setDrawerOpen(true);
  };

  const actionRequestTimestamp = (order: (typeof actionRequiredOrders)[number]): string | null => {
    const cancellationAt = order.cancellation_requested_at
      ? new Date(order.cancellation_requested_at).getTime()
      : null;
    const refundAt = order.refund_requested_at ? new Date(order.refund_requested_at).getTime() : null;
    if (refundAt !== null && (cancellationAt === null || refundAt >= cancellationAt)) {
      return order.refund_requested_at;
    }
    return order.cancellation_requested_at;
  };

  const actionRequestType = (order: (typeof actionRequiredOrders)[number]): 'cancellation' | 'refund' => {
    const cancellationAt = order.cancellation_requested_at
      ? new Date(order.cancellation_requested_at).getTime()
      : null;
    const refundAt = order.refund_requested_at ? new Date(order.refund_requested_at).getTime() : null;
    if (refundAt !== null && (cancellationAt === null || refundAt >= cancellationAt)) return 'refund';
    return 'cancellation';
  };

  const formForOrder = (orderId: string): ActionFormState =>
    actionForms[orderId] ?? {
      resolution_status: 'approved',
      resolution_notes: '',
      customer_message: '',
      resume_ai: false,
    };

  const patchForm = (orderId: string, patch: Partial<ActionFormState>) => {
    setActionForms((prev) => ({
      ...prev,
      [orderId]: {
        ...formForOrder(orderId),
        ...patch,
      },
    }));
  };

  if (!tenantId) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground">
            Review AI-detected drafts, confirm with customers, and track fulfillment.
          </p>
        </div>
        <Link
          to="/inbox"
          className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'inline-flex')}
        >
          Open Inbox
        </Link>
      </div>

      <div className="flex flex-wrap gap-1 border-b border-border pb-2">
        {STATUS_TABS.map((t) => (
          <Button
            key={t.key}
            type="button"
            size="xs"
            variant={statusTab === t.key ? 'default' : 'outline'}
            onClick={() => {
              setStatusTab(t.key);
              const next = new URLSearchParams(searchParams);
              if (t.key === 'action_required') {
                next.set('tab', 'action_required');
              } else {
                next.delete('tab');
              }
              setSearchParams(next, { replace: true });
              setPage(1);
            }}
          >
            {t.label}
            {t.key === 'action_required' && actionRequiredCount > 0 ? (
              <span className="ml-1.5 inline-flex min-w-5 justify-center rounded-full bg-red-600 px-1 text-[0.65rem] font-semibold text-white tabular-nums">
                {actionRequiredCount > 99 ? '99+' : actionRequiredCount}
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      {statusTab !== 'action_required' ? (
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="Search by customer name..."
            className="h-10 pl-9"
            aria-label="Search orders by customer"
          />
          {isFetching && debouncedSearch ? (
            <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="orders-from" className="text-xs text-muted-foreground">
              From
            </label>
            <Input
              id="orders-from"
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="h-10 w-[11rem]"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="orders-to" className="text-xs text-muted-foreground">
              To
            </label>
            <Input
              id="orders-to"
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="h-10 w-[11rem]"
            />
          </div>
          {(dateFrom || dateTo) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="self-end"
              onClick={() => {
                setDateFrom('');
                setDateTo('');
                setPage(1);
              }}
            >
              Clear dates
            </Button>
          )}
        </div>
      </div>
      ) : null}

      {statusTab === 'action_required' ? (
        actionRequiredQuery.isLoading ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : actionRequiredQuery.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            Orders requiring action could not be loaded. Please refresh.
          </div>
        ) : actionRequiredOrders.length === 0 && actionAlertTasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
            <CheckCircle2 className="size-10 text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground">
              Nuk ka veprime në pritje: anulim, rimbursim, alarme IA për përdorim produkti ose problem
              pasi-blerje.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {actionRequiredOrders.map((order) => {
              const requestType = actionRequestType(order);
              const requestAt = actionRequestTimestamp(order);
              const form = formForOrder(order.id);
              return (
                <div key={order.id} className="rounded-xl border border-red-500/30 bg-card p-4 shadow-sm">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center justify-center rounded-md bg-muted p-1.5">
                          {renderOrderChannelIcon(order.channel_type)}
                        </span>
                        <p className="truncate text-base font-semibold">{order.customer_name}</p>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {order.product_name} · Sasia {order.quantity} · ${order.total_price.toFixed(2)} ·{' '}
                        {formatRelativeShort(order.created_at)}
                      </p>
                    </div>
                    <Badge
                      variant="outline"
                      className={
                        requestType === 'cancellation'
                          ? 'border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-200'
                          : 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-200'
                      }
                    >
                      {requestType === 'cancellation' ? 'Kërkesë anulimi' : 'Kërkesë rimbursimi'}
                    </Badge>
                  </div>

                  <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Arsyeja</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">
                      {order.request_reason?.trim() || 'Ende pa arsye'}
                    </p>
                  </div>

                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground">
                      Kërkuar {requestAt ? formatRelativeShort(requestAt) : 'së fundmi'}
                    </p>
                    <Link
                      to={`/inbox?c=${order.conversation_id}`}
                      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                    >
                      Shiko bisedën
                    </Link>
                  </div>

                  <div className="mt-4 space-y-3 rounded-lg border border-border p-3">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">Zgjidhja</label>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button type="button" variant="outline" className="w-full justify-between">
                                {RESOLUTION_OPTIONS.find((o) => o.value === form.resolution_status)?.label}
                                <MoreHorizontal className="size-4 opacity-60" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="start">
                            {RESOLUTION_OPTIONS.map((option) => (
                              <DropdownMenuItem
                                key={option.value}
                                onClick={() => patchForm(order.id, { resolution_status: option.value })}
                              >
                                {option.label}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div className="flex items-end justify-between rounded-md border border-border px-3 py-2">
                        <span className="text-sm">Rifillo IA-në pas dërgimit</span>
                        <Switch
                          checked={form.resume_ai}
                          onCheckedChange={(checked) => patchForm(order.id, { resume_ai: checked })}
                        />
                      </div>
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Shënime zgjidhjeje (të brendshme)
                      </label>
                      <Textarea
                        value={form.resolution_notes}
                        onChange={(e) => patchForm(order.id, { resolution_notes: e.target.value })}
                        placeholder="Shtoni shënime të brendshme për këtë vendim"
                        rows={3}
                      />
                    </div>

                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Mesazh për klientin
                      </label>
                      <Textarea
                        value={form.customer_message}
                        onChange={(e) => patchForm(order.id, { customer_message: e.target.value })}
                        placeholder="Shkruani mesazhin për t’ia dërguar klientit"
                        rows={4}
                      />
                    </div>

                    <div className="flex justify-end">
                      <Button
                        type="button"
                        disabled={
                          sendResolutionMutation.isPending ||
                          !form.customer_message.trim() ||
                          !form.resolution_notes.trim()
                        }
                        onClick={() =>
                          sendResolutionMutation.mutate({
                            orderId: order.id,
                            resolution_status: form.resolution_status,
                            resolution_notes: form.resolution_notes.trim(),
                            message: form.customer_message.trim(),
                            resume_ai: form.resume_ai,
                          })
                        }
                      >
                        {sendResolutionMutation.isPending ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            Duke dërguar…
                          </>
                        ) : (
                          <>
                            <ShieldAlert className="size-4" />
                            Dërgo zgjidhjen
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
            {actionAlertTasks.map((task) => (
              <div
                key={task.id}
                className="rounded-xl border border-amber-500/35 bg-card p-4 shadow-sm dark:border-amber-600/40"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center justify-center rounded-md bg-muted p-1.5">
                        {renderOrderChannelIcon(task.channel_type)}
                      </span>
                      <p className="truncate text-base font-semibold">{task.contact_name}</p>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {task.channel_name} · {formatRelativeShort(task.created_at)}
                    </p>
                  </div>
                  <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10">
                    {formatFlagReason(task.reason)}
                  </Badge>
                </div>
                {task.message_content?.trim() ? (
                  <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Mesazhi / konteksti
                    </p>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{task.message_content}</p>
                  </div>
                ) : null}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={resolveAlertTaskMutation.isPending}
                    onClick={() => resolveAlertTaskMutation.mutate(task.id)}
                  >
                    {resolveAlertTaskMutation.isPending &&
                    resolveAlertTaskMutation.variables === task.id ? (
                      <>
                        <Loader2 className="size-4 animate-spin" aria-hidden />
                        Duke mbyllur…
                      </>
                    ) : (
                      'Mbyll alarmin'
                    )}
                  </Button>
                  <Link
                    to={`/inbox?c=${task.conversation_id}`}
                    className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                  >
                    Shiko bisedën
                  </Link>
                  <Link
                    to="/ai-alerts"
                    className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
                  >
                    Hap Alarmet IA
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )
      ) : isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Nuk u ngarkuan porositë. Ju lutemi rifreskoni.
        </div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <ShoppingCart className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">Asnjë porosi nuk përputhet me filtrat.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Klienti"
                      column="customer_name"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3">Produkti</th>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Sasia"
                      column="quantity"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3 text-right">
                    <SortHeader
                      label="Totali"
                      column="total_price"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3 text-center">Kanali</th>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Data"
                      column="created_at"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Statusi"
                      column="status"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3 text-right">Veprimet</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((row) => {
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-border last:border-0 hover:bg-muted/30"
                    >
                      <td className="px-3 py-2.5 font-medium">{row.customer_name}</td>
                      <td className="max-w-[200px] truncate px-3 py-2.5" title={row.product_name}>
                        {row.product_name}
                      </td>
                      <td className="px-3 py-2.5 tabular-nums">{row.quantity}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-medium">
                        ${row.total_price.toFixed(2)}
                      </td>
                      <td className="px-3 py-2.5 text-center">
                        <span className="inline-flex justify-center" title={row.channel_type}>
                          {renderOrderChannelIcon(row.channel_type)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground">
                        {formatRelativeShort(row.created_at)}
                      </td>
                      <td className="px-3 py-2.5">
                        <OrderStatusBadge status={row.status} />
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="icon-sm" aria-label="Veprimet e rreshtit">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openDrawer(row.id)}>
                              Shiko / ndrysho
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => navigate(`/inbox?c=${row.conversation_id}`)}
                            >
                              Hap bisedën
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pagination && pagination.totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}

      <OrderDetailDrawer
        orderId={drawerOrderId}
        open={drawerOpen}
        onOpenChange={(o) => {
          setDrawerOpen(o);
          if (!o) setDrawerOrderId(null);
        }}
      />
    </div>
  );
}
