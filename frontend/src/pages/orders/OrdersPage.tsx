import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Loader2,
  MoreHorizontal,
  Search,
  ShoppingCart,
} from 'lucide-react';
import { fetchOrders } from '@/api/ordersApi';
import { OrderDetailDrawer } from '@/components/orders/OrderDetailDrawer';
import { orderChannelIcon } from '@/components/orders/orderChannelIcon';
import { OrderStatusBadge } from '@/components/orders/orderStatusBadge';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import type { OrderListSortColumn, OrderStatus } from '@/types/order';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 20;

const STATUS_TABS: { key: 'all' | OrderStatus; label: string; filter?: OrderStatus }[] = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft', filter: 'draft' },
  { key: 'confirmed', label: 'Confirmed', filter: 'confirmed' },
  { key: 'processing', label: 'Processing', filter: 'processing' },
  { key: 'shipped', label: 'Shipped', filter: 'shipped' },
  { key: 'delivered', label: 'Delivered', filter: 'delivered' },
  { key: 'cancelled', label: 'Cancelled', filter: 'cancelled' },
];

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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [statusTab, setStatusTab] = useState<(typeof STATUS_TABS)[number]['key']>('all');
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [sortColumn, setSortColumn] = useState<OrderListSortColumn>('created_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [drawerOrderId, setDrawerOrderId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const openFromQuery = searchParams.get('open');
  useEffect(() => {
    if (!openFromQuery || !/^[0-9a-f-]{36}$/i.test(openFromQuery)) return;
    setDrawerOrderId(openFromQuery);
    setDrawerOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete('open');
    setSearchParams(next, { replace: true });
  }, [openFromQuery, searchParams, setSearchParams]);

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
    enabled: Boolean(tenantId),
  });

  const orders = data?.orders ?? [];
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
          Open inbox
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
              setPage(1);
            }}
          >
            {t.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="Search by customer name…"
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

      {isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Could not load orders. Please refresh.
        </div>
      ) : orders.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <ShoppingCart className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">No orders match your filters.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Customer"
                      column="customer_name"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3">Product</th>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Qty"
                      column="quantity"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3 text-right">
                    <SortHeader
                      label="Total"
                      column="total_price"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3 text-center">Channel</th>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Date"
                      column="created_at"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3">
                    <SortHeader
                      label="Status"
                      column="status"
                      activeColumn={sortColumn}
                      direction={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((row) => {
                  const Icon = orderChannelIcon(row.channel_type);
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
                          <Icon className="size-4 text-muted-foreground" />
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
                              <Button variant="ghost" size="icon-sm" aria-label="Row actions">
                                <MoreHorizontal className="size-4" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => openDrawer(row.id)}>
                              View / edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => navigate(`/inbox?c=${row.conversation_id}`)}
                            >
                              Open conversation
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
