import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAdminBusinessOverview,
  fetchAdminBusinessPeriodStats,
  fetchAdminCommissionableOrders,
  postAdminGenerateReport,
  postAdminMarkBilled,
  postAdminMarkPaid,
} from '@/api/platformAdminApi';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/formatCurrency';
import { cn } from '@/lib/utils';

const ORDERS_PAGE_SIZE = 20;

function toYmdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start: toYmdLocal(start), end: toYmdLocal(now) };
}

function commissionBadgeVariant(s: string): 'destructive' | 'secondary' | 'default' {
  if (s === 'unpaid') return 'destructive';
  if (s === 'billed') return 'secondary';
  return 'default';
}

export default function AdminBusinessDetailPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const queryClient = useQueryClient();
  const [{ start: periodStart, end: periodEnd }, setPeriod] = useState(defaultPeriod);
  const [ordersPage, setOrdersPage] = useState(1);

  const periodValid = useMemo(() => periodEnd >= periodStart, [periodStart, periodEnd]);

  const overviewQuery = useQuery({
    queryKey: ['admin', 'business', tenantId, 'overview'],
    queryFn: () => fetchAdminBusinessOverview(tenantId!),
    enabled: Boolean(tenantId),
  });

  const statsQuery = useQuery({
    queryKey: ['admin', 'business', tenantId, 'period-stats', periodStart, periodEnd],
    queryFn: () => fetchAdminBusinessPeriodStats(tenantId!, periodStart, periodEnd),
    enabled: Boolean(tenantId) && periodValid,
  });

  const ordersQuery = useQuery({
    queryKey: ['admin', 'business', tenantId, 'orders', ordersPage, periodStart, periodEnd],
    queryFn: () =>
      fetchAdminCommissionableOrders(
        tenantId!,
        ordersPage,
        ORDERS_PAGE_SIZE,
        periodValid ? { start: periodStart, end: periodEnd } : undefined,
      ),
    enabled: Boolean(tenantId) && periodValid,
  });

  const invalidateBusiness = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'business', tenantId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'businesses'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'commission-reports'] });
  };

  const markBilledMutation = useMutation({
    mutationFn: () => postAdminMarkBilled(tenantId!, { period_start: periodStart, period_end: periodEnd }),
    onSuccess: (count) => {
      toast.success(`Marked ${count} order(s) as billed.`);
      invalidateBusiness();
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? e.response?.data?.message ?? 'Request failed' : 'Request failed');
    },
  });

  const markPaidMutation = useMutation({
    mutationFn: () => postAdminMarkPaid(tenantId!, { period_start: periodStart, period_end: periodEnd }),
    onSuccess: (count) => {
      toast.success(`Marked ${count} order(s) as paid.`);
      invalidateBusiness();
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? e.response?.data?.message ?? 'Request failed' : 'Request failed');
    },
  });

  const generateReportMutation = useMutation({
    mutationFn: () => postAdminGenerateReport(tenantId!, { period_start: periodStart, period_end: periodEnd }),
    onSuccess: () => {
      toast.success('Commission report generated.');
      invalidateBusiness();
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? e.response?.data?.message ?? 'Request failed' : 'Request failed');
    },
  });

  const tenant = overviewQuery.data?.tenant;
  const channels = overviewQuery.data?.channels ?? [];
  const stats = statsQuery.data;
  const orders = ordersQuery.data?.rows ?? [];
  const ordersPagination = ordersQuery.data?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          to="/admin/businesses"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'gap-1.5 px-0')}
        >
          <ArrowLeft className="size-4" />
          Businesses
        </Link>
      </div>

      {overviewQuery.isLoading ? (
        <Skeleton className="h-32 w-full max-w-2xl" />
      ) : overviewQuery.isError || !tenant ? (
        <p className="text-destructive">Business not found.</p>
      ) : (
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.name}</h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{tenant.niche}</span>
            {tenant.description ? ` — ${tenant.description}` : null}
          </p>
          <div className="pt-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Channels</p>
            {channels.length === 0 ? (
              <p className="text-sm text-muted-foreground">No channels connected.</p>
            ) : (
              <ul className="mt-1 flex flex-wrap gap-2">
                {channels.map((ch) => (
                  <li key={ch.id}>
                    <Badge variant="outline">
                      {ch.type} · {ch.name}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Commissionable AI orders (period)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsQuery.isLoading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <p className="text-2xl font-bold tabular-nums">{stats?.commissionable_ai_orders ?? '—'}</p>
            )}
          </CardContent>
        </Card>
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Commission owed (unpaid, period)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsQuery.isLoading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <p className="text-2xl font-bold tabular-nums text-amber-800 dark:text-amber-300">
                {formatCurrency(stats?.commission_unpaid ?? 0)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Commission paid (period)
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statsQuery.isLoading ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <p className="text-2xl font-bold tabular-nums">{formatCurrency(stats?.commission_paid ?? 0)}</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Period & actions</CardTitle>
          <p className="text-sm text-muted-foreground">
            Filter commissionable orders and run billing actions for the selected inclusive date range.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-2">
              <Label htmlFor="period-start">From</Label>
              <Input
                id="period-start"
                type="date"
                value={periodStart}
                onChange={(e) => {
                  setPeriod((p) => ({ ...p, start: e.target.value }));
                  setOrdersPage(1);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="period-end">To</Label>
              <Input
                id="period-end"
                type="date"
                value={periodEnd}
                onChange={(e) => {
                  setPeriod((p) => ({ ...p, end: e.target.value }));
                  setOrdersPage(1);
                }}
              />
            </div>
          </div>
          {!periodValid ? (
            <p className="text-sm text-destructive">&quot;To&quot; must be on or after &quot;From&quot;.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              disabled={!periodValid || markBilledMutation.isPending}
              onClick={() => markBilledMutation.mutate()}
            >
              {markBilledMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Mark as billed
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={!periodValid || markPaidMutation.isPending}
              onClick={() => markPaidMutation.mutate()}
            >
              {markPaidMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Mark as paid
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={!periodValid || generateReportMutation.isPending}
              onClick={() => generateReportMutation.mutate()}
            >
              {generateReportMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Generate report
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Commissionable orders</CardTitle>
          <p className="text-sm text-muted-foreground">
            Orders placed by AI while no human had replied in the thread (5% commission).
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[800px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-4 py-3 font-medium">Order ID</th>
                  <th className="px-4 py-3 font-medium">Customer</th>
                  <th className="px-4 py-3 font-medium">Product</th>
                  <th className="px-4 py-3 font-medium text-right">Order total</th>
                  <th className="px-4 py-3 font-medium text-right">Commission</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {!periodValid ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                      Select a valid date range.
                    </td>
                  </tr>
                ) : ordersQuery.isLoading ? (
                  <tr>
                    <td className="px-4 py-8" colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
                      No commissionable orders in this period.
                    </td>
                  </tr>
                ) : (
                  orders.map((o) => (
                    <tr key={o.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-mono text-xs">{o.id}</td>
                      <td className="px-4 py-3">{o.customer_name}</td>
                      <td className="px-4 py-3">{o.product_name}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(o.total_price)}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {formatCurrency(o.commission_amount)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {new Date(o.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <Badge variant={commissionBadgeVariant(o.commission_status)}>{o.commission_status}</Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {ordersPagination && ordersPagination.totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {ordersPagination.page} of {ordersPagination.totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={ordersPagination.page <= 1}
              onClick={() => setOrdersPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={ordersPagination.page >= ordersPagination.totalPages}
              onClick={() => setOrdersPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
