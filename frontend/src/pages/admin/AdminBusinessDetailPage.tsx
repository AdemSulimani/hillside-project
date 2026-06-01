import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import AdminBusinessAiPanel from '@/pages/admin/AdminBusinessAiPanel';
import {
  fetchAdminBusinessOverview,
  fetchAdminBusinessPeriodStats,
  fetchAdminCommissionableOrders,
  fetchAdminBusinessUseCases,
  fetchAdminBusinessUseCasePeriodStats,
  patchAdminOrderCommissionStatus,
  patchAdminUseCaseBillingStatus,
  postAdminVoidUseCase,
  postAdminStampUseCaseFees,
  postAdminMarkUseCasesBilled,
  postAdminMarkUseCasesPaid,
  postAdminGenerateReport,
  postAdminBackfillProductEmbeddings,
  type AdminUseCaseRow,
  type CommissionableOrderRow,
} from '@/api/platformAdminApi';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatCurrency } from '@/lib/formatCurrency';
import { cn } from '@/lib/utils';

const ORDERS_PAGE_SIZE = 20;
const USE_CASES_PAGE_SIZE = 20;

const COMMISSION_STATUS_OPTIONS: CommissionableOrderRow['commission_status'][] = ['unpaid', 'billed', 'paid'];
const USE_CASE_BILLING_STATUS_OPTIONS: AdminUseCaseRow['billing_status'][] = ['unbilled', 'billed', 'paid'];

const selectClass =
  'h-8 min-w-[108px] rounded-md border border-input bg-background px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50';

function toYmdLocal(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 29); // last 30 days inclusive
  return { start: toYmdLocal(start), end: toYmdLocal(now) };
}

/** YYYY-MM from a date string — used for billing_period bulk actions. */
function toBillingPeriod(ymd: string): string {
  return ymd.slice(0, 7);
}

export default function AdminBusinessDetailPage() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const queryClient = useQueryClient();
  const [{ start: periodStart, end: periodEnd }, setPeriod] = useState(defaultPeriod);
  const [ordersPage, setOrdersPage] = useState(1);
  const [useCasesPage, setUseCasesPage] = useState(1);
  const [updatingOrderId, setUpdatingOrderId] = useState<string | null>(null);
  const [updatingUseCaseId, setUpdatingUseCaseId] = useState<string | null>(null);

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

  const useCaseStatsQuery = useQuery({
    queryKey: ['admin', 'business', tenantId, 'use-case-period-stats', periodStart, periodEnd],
    queryFn: () => fetchAdminBusinessUseCasePeriodStats(tenantId!, periodStart, periodEnd),
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

  const useCasesQuery = useQuery({
    queryKey: ['admin', 'business', tenantId, 'use-cases', useCasesPage],
    queryFn: () => fetchAdminBusinessUseCases(tenantId!, useCasesPage, USE_CASES_PAGE_SIZE),
    enabled: Boolean(tenantId),
  });

  const invalidateBusiness = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'business', tenantId] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'businesses'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'dashboard'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'commission-reports'] });
  };

  const patchCommissionMutation = useMutation({
    mutationFn: ({ orderId, commission_status }: { orderId: string; commission_status: CommissionableOrderRow['commission_status'] }) =>
      patchAdminOrderCommissionStatus(orderId, { commission_status }),
    onMutate: ({ orderId }) => setUpdatingOrderId(orderId),
    onSettled: () => setUpdatingOrderId(null),
    onSuccess: () => {
      invalidateBusiness();
      toast.success('Commission status updated');
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Update failed' : 'Update failed');
    },
  });

  const patchUseCaseMutation = useMutation({
    mutationFn: ({ useCaseId, billing_status }: { useCaseId: string; billing_status: AdminUseCaseRow['billing_status'] }) =>
      patchAdminUseCaseBillingStatus(useCaseId, { billing_status }),
    onMutate: ({ useCaseId }) => setUpdatingUseCaseId(useCaseId),
    onSettled: () => setUpdatingUseCaseId(null),
    onSuccess: () => {
      invalidateBusiness();
      toast.success('Use case billing status updated');
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Update failed' : 'Update failed');
    },
  });

  const voidUseCaseMutation = useMutation({
    mutationFn: (useCaseId: string) => postAdminVoidUseCase(useCaseId),
    onMutate: (useCaseId) => setUpdatingUseCaseId(useCaseId),
    onSettled: () => setUpdatingUseCaseId(null),
    onSuccess: () => {
      invalidateBusiness();
      toast.success('Use case voided');
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Void failed' : 'Void failed');
    },
  });

  const stampFeesMutation = useMutation({
    mutationFn: () =>
      postAdminStampUseCaseFees(tenantId!, { billing_period: toBillingPeriod(periodStart) }),
    onSuccess: (result) => {
      invalidateBusiness();
      if (result.stamped_count === 0) {
        toast.info('No completed use cases found for that billing period.');
      } else {
        toast.success(
          `Fees stamped for ${result.stamped_count} use case(s) — ${result.stamped_count} × $${result.fee_per_case.toFixed(2)} = $${result.total_fee.toFixed(2)} total`,
        );
      }
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Request failed' : 'Request failed');
    },
  });

  const markUseCasesBilledMutation = useMutation({
    mutationFn: () =>
      postAdminMarkUseCasesBilled(tenantId!, { billing_period: toBillingPeriod(periodStart) }),
    onSuccess: (count) => {
      invalidateBusiness();
      toast.success(`${count} use case(s) marked as billed`);
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Request failed' : 'Request failed');
    },
  });

  const markUseCasesPaidMutation = useMutation({
    mutationFn: () =>
      postAdminMarkUseCasesPaid(tenantId!, { billing_period: toBillingPeriod(periodStart) }),
    onSuccess: (count) => {
      invalidateBusiness();
      toast.success(`${count} use case(s) marked as paid`);
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Request failed' : 'Request failed');
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

  const backfillEmbeddingsMutation = useMutation({
    mutationFn: () => postAdminBackfillProductEmbeddings(tenantId!),
    onSuccess: (result) => {
      if (result.queued === 0) {
        toast.info('All products already have embeddings — nothing to backfill.');
      } else {
        toast.success(`Queued embedding generation for ${result.queued} product(s). They will be indexed shortly.`);
      }
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Backfill failed' : 'Backfill failed');
    },
  });

  const tenant = overviewQuery.data?.tenant;
  const channels = overviewQuery.data?.channels ?? [];
  const stats = statsQuery.data;
  const ucStats = useCaseStatsQuery.data;
  const orders = ordersQuery.data?.rows ?? [];
  const ordersPagination = ordersQuery.data?.pagination;
  const useCases = useCasesQuery.data?.rows ?? [];
  const useCasesPagination = useCasesQuery.data?.pagination;

  const billingPeriodLabel = toBillingPeriod(periodStart);
  const isBulkBusy =
    stampFeesMutation.isPending ||
    markUseCasesBilledMutation.isPending ||
    markUseCasesPaidMutation.isPending;

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

      {tenant?.id ? (
        <Tabs defaultValue="ai" className="w-full">
          <TabsList className="w-fit">
            <TabsTrigger value="ai">AI assistant</TabsTrigger>
            <TabsTrigger value="commissions">Commissions</TabsTrigger>
          </TabsList>
          <TabsContent value="ai" className="mt-4 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Product embeddings</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Products imported via spreadsheet or PDF before June 2026 may be missing
                  semantic embeddings, which causes the AI to miss them during customer
                  conversations. Use this to queue embedding generation for all products that
                  currently lack one.
                </p>
              </CardHeader>
              <CardContent>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={backfillEmbeddingsMutation.isPending}
                  onClick={() => backfillEmbeddingsMutation.mutate()}
                >
                  {backfillEmbeddingsMutation.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                  Backfill missing embeddings
                </Button>
              </CardContent>
            </Card>
            <AdminBusinessAiPanel tenantId={tenant.id} />
          </TabsContent>
          <TabsContent value="commissions" className="mt-4 space-y-8">

            {/* ── Period & date range selector ─────────────────────────────── */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Period & report</CardTitle>
                <p className="text-sm text-muted-foreground">
                  Select a date range to filter the stats and orders below. Bulk use case actions
                  operate on the <span className="font-medium text-foreground">billing period</span>{' '}
                  derived from the &quot;From&quot; date (e.g. <code className="text-xs">{billingPeriodLabel}</code>).
                  Use <span className="font-medium text-foreground">Generate report</span> to save a
                  billing snapshot for invoicing.
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
                        setUseCasesPage(1);
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
                        setUseCasesPage(1);
                      }}
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="mt-auto"
                    disabled={!periodValid || generateReportMutation.isPending}
                    onClick={() => generateReportMutation.mutate()}
                  >
                    {generateReportMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                    Generate report
                  </Button>
                </div>
                {!periodValid ? (
                  <p className="text-sm text-destructive">&quot;To&quot; must be on or after &quot;From&quot;.</p>
                ) : null}
              </CardContent>
            </Card>

            {/* ── AI order commissions ──────────────────────────────────────── */}
            <section className="space-y-4">
              <h2 className="text-base font-semibold">AI order commissions (5%)</h2>

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
                  <CardTitle className="text-base">Commissionable orders</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Orders placed by AI while no human had replied (5% commission). Edit status per row.
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[880px] text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-left">
                          <th className="px-4 py-3 font-medium">Order ID</th>
                          <th className="px-4 py-3 font-medium">Customer</th>
                          <th className="px-4 py-3 font-medium">Product</th>
                          <th className="px-4 py-3 font-medium text-right">Order total</th>
                          <th className="px-4 py-3 font-medium text-right">Commission</th>
                          <th className="px-4 py-3 font-medium">Date</th>
                          <th className="px-4 py-3 font-medium">Commission status</th>
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
                                <div className="flex items-center gap-2">
                                  <select
                                    className={selectClass}
                                    value={o.commission_status}
                                    disabled={updatingOrderId === o.id}
                                    aria-label={`Commission status for order ${o.id}`}
                                    onChange={(e) => {
                                      const commission_status = e.target.value as CommissionableOrderRow['commission_status'];
                                      if (commission_status !== o.commission_status) {
                                        patchCommissionMutation.mutate({ orderId: o.id, commission_status });
                                      }
                                    }}
                                  >
                                    {COMMISSION_STATUS_OPTIONS.map((s) => (
                                      <option key={s} value={s}>
                                        {s.charAt(0).toUpperCase() + s.slice(1)}
                                      </option>
                                    ))}
                                  </select>
                                  {updatingOrderId === o.id ? (
                                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                                  ) : null}
                                </div>
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
            </section>

            {/* ── AI use case fees ─────────────────────────────────────────── */}
            <section className="space-y-4">
              <h2 className="text-base font-semibold">AI use case fees (progressive tiers)</h2>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      Completed use cases (period)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {useCaseStatsQuery.isLoading ? (
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    ) : (
                      <p className="text-2xl font-bold tabular-nums">{ucStats?.completed_use_cases ?? '—'}</p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      Unbilled (period)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {useCaseStatsQuery.isLoading ? (
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    ) : (
                      <p className="text-2xl font-bold tabular-nums">{ucStats?.use_case_unbilled ?? '—'}</p>
                    )}
                  </CardContent>
                </Card>
                <Card className="border-amber-500/30 bg-amber-500/5">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-amber-900 dark:text-amber-200">
                      Fees billed, unpaid (period)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {useCaseStatsQuery.isLoading ? (
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    ) : (
                      <p className="text-2xl font-bold tabular-nums text-amber-800 dark:text-amber-300">
                        {formatCurrency(ucStats?.use_case_fees_billed ?? 0)}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium text-muted-foreground">
                      Fees paid (period)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {useCaseStatsQuery.isLoading ? (
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    ) : (
                      <p className="text-2xl font-bold tabular-nums">{formatCurrency(ucStats?.use_case_fees_paid ?? 0)}</p>
                    )}
                  </CardContent>
                </Card>
              </div>

              {/* Bulk billing period actions */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Bulk billing period actions</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Actions apply to billing period{' '}
                    <span className="font-medium text-foreground">{billingPeriodLabel}</span> (from
                    the &quot;From&quot; date). Run in order: first <strong>Calculate fees</strong> to
                    stamp amounts, then mark as billed for invoicing, then paid when settled.
                  </p>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-3">
                    <Button
                      type="button"
                      variant="default"
                      disabled={isBulkBusy || !periodValid}
                      onClick={() => stampFeesMutation.mutate()}
                    >
                      {stampFeesMutation.isPending
                        ? <Loader2 className="mr-2 size-4 animate-spin" />
                        : null}
                      1. Calculate fees ({billingPeriodLabel})
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isBulkBusy || !periodValid}
                      onClick={() => markUseCasesBilledMutation.mutate()}
                    >
                      {markUseCasesBilledMutation.isPending
                        ? <Loader2 className="mr-2 size-4 animate-spin" />
                        : null}
                      2. Mark unbilled → billed ({billingPeriodLabel})
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isBulkBusy || !periodValid}
                      onClick={() => markUseCasesPaidMutation.mutate()}
                    >
                      {markUseCasesPaidMutation.isPending
                        ? <Loader2 className="mr-2 size-4 animate-spin" />
                        : null}
                      3. Mark billed → paid ({billingPeriodLabel})
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Use cases table (all, not period-filtered) */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">All use cases</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Every AI-completed conversation for this business. Fees are stamped by the
                    month-end billing job. Use the dropdown to override a billing status, or void an
                    unbilled case if it was recorded in error.
                  </p>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[960px] text-sm">
                      <thead>
                        <tr className="border-b border-border bg-muted/40 text-left">
                          <th className="px-4 py-3 font-medium">Use case ID</th>
                          <th className="px-4 py-3 font-medium">Contact</th>
                          <th className="px-4 py-3 font-medium">Resolved</th>
                          <th className="px-4 py-3 font-medium">Status</th>
                          <th className="px-4 py-3 font-medium">Billing period</th>
                          <th className="px-4 py-3 font-medium text-right">Fee</th>
                          <th className="px-4 py-3 font-medium">Billing status</th>
                          <th className="px-4 py-3 font-medium"> </th>
                        </tr>
                      </thead>
                      <tbody>
                        {useCasesQuery.isLoading ? (
                          <tr>
                            <td className="px-4 py-8" colSpan={8}>
                              <Skeleton className="h-8 w-full" />
                            </td>
                          </tr>
                        ) : useCases.length === 0 ? (
                          <tr>
                            <td className="px-4 py-8 text-center text-muted-foreground" colSpan={8}>
                              No use cases recorded for this business.
                            </td>
                          </tr>
                        ) : (
                          useCases.map((uc) => {
                            const isBusy = updatingUseCaseId === uc.id;
                            const isVoided = uc.status === 'voided';
                            return (
                              <tr
                                key={uc.id}
                                className={cn(
                                  'border-b border-border last:border-0',
                                  isVoided && 'opacity-50',
                                )}
                              >
                                <td className="px-4 py-3 font-mono text-xs">{uc.id}</td>
                                <td className="px-4 py-3">{uc.contact_name}</td>
                                <td className="px-4 py-3 text-muted-foreground">
                                  {new Date(uc.resolved_at).toLocaleString()}
                                </td>
                                <td className="px-4 py-3">
                                  <Badge variant={isVoided ? 'outline' : 'secondary'}>
                                    {uc.status}
                                  </Badge>
                                </td>
                                <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                                  {uc.billing_period ?? '—'}
                                </td>
                                <td className="px-4 py-3 text-right tabular-nums font-medium">
                                  {uc.fee_amount != null ? formatCurrency(uc.fee_amount) : '—'}
                                </td>
                                <td className="px-4 py-3">
                                  {isVoided ? (
                                    <span className="text-xs text-muted-foreground">voided</span>
                                  ) : (
                                    <div className="flex items-center gap-2">
                                      <select
                                        className={selectClass}
                                        value={uc.billing_status}
                                        disabled={isBusy}
                                        aria-label={`Billing status for use case ${uc.id}`}
                                        onChange={(e) => {
                                          const billing_status = e.target.value as AdminUseCaseRow['billing_status'];
                                          if (billing_status !== uc.billing_status) {
                                            patchUseCaseMutation.mutate({ useCaseId: uc.id, billing_status });
                                          }
                                        }}
                                      >
                                        {USE_CASE_BILLING_STATUS_OPTIONS.map((s) => (
                                          <option key={s} value={s}>
                                            {s.charAt(0).toUpperCase() + s.slice(1)}
                                          </option>
                                        ))}
                                      </select>
                                      {isBusy ? (
                                        <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
                                      ) : null}
                                    </div>
                                  )}
                                </td>
                                <td className="px-4 py-3">
                                  {!isVoided && uc.billing_status === 'unbilled' ? (
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="text-destructive hover:text-destructive"
                                      disabled={isBusy}
                                      onClick={() => voidUseCaseMutation.mutate(uc.id)}
                                    >
                                      Void
                                    </Button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {useCasesPagination && useCasesPagination.totalPages > 1 ? (
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    Page {useCasesPagination.page} of {useCasesPagination.totalPages}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={useCasesPagination.page <= 1}
                      onClick={() => setUseCasesPage((p) => Math.max(1, p - 1))}
                    >
                      Previous
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={useCasesPagination.page >= useCasesPagination.totalPages}
                      onClick={() => setUseCasesPage((p) => p + 1)}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              ) : null}
            </section>

          </TabsContent>
        </Tabs>
      ) : null}
    </div>
  );
}
