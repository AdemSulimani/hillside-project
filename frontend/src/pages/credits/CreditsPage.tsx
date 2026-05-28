import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import {
  CreditCard,
  ShoppingCart,
  Bot,
  FileText,
  TrendingUp,
  Receipt,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  User,
  MessageSquare,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet';
import { fetchConversationThread } from '@/api/conversationsApi';
import {
  fetchCreditsSummary,
  fetchMonthlyBreakdown,
  fetchDailyUseCaseVolume,
  fetchBillingHistory,
  fetchTierStatus,
  fetchAiUseCases,
} from '@/api/creditsApi';

function formatEur(value: number): string {
  return `€${value.toFixed(2)}`;
}

function formatMonthKey(key: string): string {
  const [y, m] = key.split('-');
  const date = new Date(Number(y), Number(m) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function formatDay(day: string): string {
  const d = new Date(day + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function BillingStatusBadge({ status }: { status: string }) {
  if (status === 'paid') {
    return (
      <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent">
        Paid
      </Badge>
    );
  }
  if (status === 'billed') {
    return (
      <Badge variant="secondary">
        Billed
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-amber-600 border-amber-400/40">
      Unpaid
    </Badge>
  );
}

function UseCaseBillingBadge({ status }: { status: string }) {
  if (status === 'paid') {
    return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-transparent">Paid</Badge>;
  }
  if (status === 'billed') {
    return <Badge variant="secondary">Billed</Badge>;
  }
  if (status === 'voided') {
    return <Badge variant="outline" className="text-muted-foreground">Voided</Badge>;
  }
  return <Badge variant="outline" className="text-amber-600 border-amber-400/40">Unbilled</Badge>;
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof CreditCard;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
          <Icon className="size-4 shrink-0 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tracking-tight">{value}</p>
        {sub ? <p className="mt-1 text-xs text-muted-foreground">{sub}</p> : null}
      </CardContent>
    </Card>
  );
}

function StatCardSkeleton() {
  return (
    <Card>
      <CardHeader className="pb-2">
        <Skeleton className="h-4 w-32" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-24" />
      </CardContent>
    </Card>
  );
}

interface SelectedUseCase {
  id: string;
  conversation_id: string;
  contact_name: string;
  resolved_at: string;
  billing_period: string | null;
  fee_amount: number | null;
  billing_status: string;
}

function ConversationPreviewSheet({
  useCase,
  onClose,
}: {
  useCase: SelectedUseCase | null;
  onClose: () => void;
}) {
  const threadQuery = useQuery({
    queryKey: ['conversation-thread', useCase?.conversation_id],
    queryFn: () => fetchConversationThread(useCase!.conversation_id, { limit: 50 }),
    enabled: Boolean(useCase?.conversation_id),
    staleTime: 60_000,
  });

  if (!useCase) return null;

  const messages = threadQuery.data?.messages ?? [];
  const aiMessages = messages.filter((m) => m.sent_by === 'ai');
  const lastAiMessage = aiMessages[aiMessages.length - 1];

  return (
    <Sheet open={Boolean(useCase)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col sm:max-w-lg p-0">
        <SheetHeader className="border-b border-border px-5 py-4">
          <SheetTitle className="flex items-center gap-2">
            <User className="size-4 text-muted-foreground" />
            {useCase.contact_name}
          </SheetTitle>
          <SheetDescription>
            Resolved {new Date(useCase.resolved_at).toLocaleDateString('en-GB', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })}
            {useCase.billing_period ? ` · Period ${useCase.billing_period}` : ''}
            {useCase.fee_amount != null ? ` · ${formatEur(useCase.fee_amount)}` : ''}
          </SheetDescription>
        </SheetHeader>

        {/* Message transcript */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {threadQuery.isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className={`flex ${i % 2 === 0 ? 'justify-start' : 'justify-end'}`}>
                  <Skeleton className="h-12 w-2/3 rounded-xl" />
                </div>
              ))}
            </div>
          ) : threadQuery.isError ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Could not load conversation.
            </p>
          ) : messages.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No messages in this conversation.
            </p>
          ) : (
            messages.map((msg) => {
              const isAi = msg.sent_by === 'ai';
              const isCustomer = msg.sent_by === 'customer';
              return (
                <div
                  key={msg.id}
                  className={`flex gap-2 ${isCustomer ? 'justify-start' : 'justify-end'}`}
                >
                  <div
                    className={`max-w-[82%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed ${
                      isCustomer
                        ? 'bg-muted text-foreground rounded-tl-sm'
                        : isAi
                        ? 'bg-emerald-500/15 text-emerald-900 dark:text-emerald-100 rounded-tr-sm'
                        : 'bg-primary/10 text-foreground rounded-tr-sm'
                    }`}
                  >
                    {isAi && (
                      <p className="mb-1 flex items-center gap-1 text-[0.65rem] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                        <Bot className="size-3" />
                        AI
                      </p>
                    )}
                    {msg.content ? (
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                    ) : msg.attachment_urls.length > 0 ? (
                      <p className="italic text-muted-foreground">Attachment</p>
                    ) : null}
                    <p className="mt-1 text-[0.65rem] text-muted-foreground/70 text-right">
                      {new Date(msg.created_at).toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Summary strip — last AI message preview */}
        {lastAiMessage?.content && !threadQuery.isLoading && (
          <div className="border-t border-border bg-muted/40 px-4 py-3">
            <p className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <MessageSquare className="size-3" />
              Last AI message
            </p>
            <p className="line-clamp-2 text-sm text-foreground">{lastAiMessage.content}</p>
          </div>
        )}

        <SheetFooter className="border-t border-border px-4 py-3">
          <Link
            to={`/inbox?c=${useCase.conversation_id}`}
            onClick={onClose}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <ExternalLink className="size-4" />
            Open in Inbox
          </Link>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export default function CreditsPage() {
  const [billingHistoryPage, setBillingHistoryPage] = useState(1);
  const [useCasesPage, setUseCasesPage] = useState(1);
  const [selectedUseCase, setSelectedUseCase] = useState<SelectedUseCase | null>(null);

  const summaryQuery = useQuery({
    queryKey: ['credits', 'summary'],
    queryFn: fetchCreditsSummary,
    refetchInterval: 60_000,
  });

  const tierQuery = useQuery({
    queryKey: ['credits', 'tier-status'],
    queryFn: fetchTierStatus,
    refetchInterval: 60_000,
  });

  const monthlyQuery = useQuery({
    queryKey: ['credits', 'monthly-breakdown'],
    queryFn: fetchMonthlyBreakdown,
  });

  const dailyQuery = useQuery({
    queryKey: ['credits', 'daily-volume'],
    queryFn: fetchDailyUseCaseVolume,
    refetchInterval: 60_000,
  });

  const billingHistoryQuery = useQuery({
    queryKey: ['credits', 'billing-history', billingHistoryPage],
    queryFn: () => fetchBillingHistory(billingHistoryPage, 12),
  });

  const useCasesQuery = useQuery({
    queryKey: ['credits', 'use-cases', useCasesPage],
    queryFn: () => fetchAiUseCases(useCasesPage, 15),
  });

  const summary = summaryQuery.data;
  const tier = tierQuery.data;
  const monthly = monthlyQuery.data ?? [];
  const daily = dailyQuery.data ?? [];

  const tierThresholds = [250, 500, 1000];
  const nextThreshold = tier
    ? (tierThresholds.find((t) => t > (tier.current_count)) ?? null)
    : null;
  const tierProgress = tier && nextThreshold
    ? Math.min(100, (tier.current_count / nextThreshold) * 100)
    : tier && !nextThreshold
    ? 100
    : 0;

  return (
    <div className="flex flex-col gap-6">
      <ConversationPreviewSheet
        useCase={selectedUseCase}
        onClose={() => setSelectedUseCase(null)}
      />

      {/* Page heading */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Credits & Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Live overview of your AI commission costs and use case fees for this month.
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {summaryQuery.isLoading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <StatCard
              label="Commission This Month"
              value={formatEur(summary?.commission_this_month ?? 0)}
              sub={`${summary?.ai_orders_this_month ?? 0} AI orders`}
              icon={ShoppingCart}
            />
            <StatCard
              label="Use Case Fees This Month"
              value={formatEur(summary?.use_case_fees_this_month ?? 0)}
              sub={`${summary?.use_case_count_this_month ?? 0} cases resolved`}
              icon={Bot}
            />
            <StatCard
              label="Estimated Invoice"
              value={formatEur(summary?.estimated_invoice ?? 0)}
              sub="Commission + use case fees"
              icon={Receipt}
            />
            <StatCard
              label="Total Outstanding"
              value={formatEur(
                (summary?.total_unpaid_commission ?? 0) +
                  (summary?.total_unpaid_use_case_fees ?? 0),
              )}
              sub="Across all periods"
              icon={CreditCard}
            />
          </>
        )}
      </div>

      {/* Tier panel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="size-4 text-muted-foreground" />
            Current Pricing Tier
          </CardTitle>
          <CardDescription>
            Use case volume resets on the 1st of each month.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tierQuery.isLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-full" />
            </div>
          ) : tier ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{tier.current_count}</span>
                  {nextThreshold ? (
                    <span className="text-muted-foreground"> / {nextThreshold} cases</span>
                  ) : (
                    <span className="text-muted-foreground"> cases (max tier)</span>
                  )}
                </span>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>
                    Current rate:{' '}
                    <span className="font-medium text-foreground">
                      €{tier.current_tier.rate.toFixed(2)}/case
                    </span>{' '}
                    <span className="text-xs">({tier.current_tier.label})</span>
                  </span>
                  <span>
                    Projected fee:{' '}
                    <span className="font-semibold text-foreground">
                      {formatEur(tier.projected_fee)}
                    </span>
                  </span>
                </div>
              </div>

              {/* Progress bar */}
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-500"
                  style={{ width: `${tierProgress}%` }}
                />
              </div>

              {tier.next_tier && tier.cases_to_next_tier != null ? (
                <p className="text-xs text-muted-foreground">
                  {tier.cases_to_next_tier} more cases until the next tier (
                  €{tier.next_tier.rate.toFixed(2)}/case for cases above {tier.next_tier.lowerBound - 1})
                </p>
              ) : !tier.next_tier ? (
                <p className="text-xs text-muted-foreground">
                  You are in the highest pricing tier — €0.20/case applies to all additional cases.
                </p>
              ) : null}

              {/* Tier reference table */}
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-border p-3 text-xs sm:grid-cols-4">
                {[
                  { label: '0–250 cases', rate: '€0.50/case' },
                  { label: '251–500 cases', rate: '€0.40/case' },
                  { label: '501–1000 cases', rate: '€0.30/case' },
                  { label: '1000+ cases', rate: '€0.20/case' },
                ].map(({ label, rate }) => (
                  <div key={label} className="flex items-center justify-between gap-1">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-medium">{rate}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {/* Monthly breakdown chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <BarChart className="size-4 text-muted-foreground" />
            Monthly Billing Breakdown
          </CardTitle>
          <CardDescription>Commission and use case fees over the last 12 months.</CardDescription>
        </CardHeader>
        <CardContent>
          {monthlyQuery.isLoading ? (
            <Skeleton className="h-56 w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={224}>
              <BarChart data={monthly} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="month_key"
                  tickFormatter={formatMonthKey}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  tickFormatter={(v: number) => `€${v}`}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  width={52}
                />
                <Tooltip
                  formatter={(value, name) => {
                    const n = typeof value === 'number' ? value : Number(value);
                    return [
                      formatEur(Number.isFinite(n) ? n : 0),
                      name === 'commission' ? 'Commission' : 'Use Case Fees',
                    ];
                  }}
                  labelFormatter={(label) => formatMonthKey(String(label ?? ''))}
                />
                <Legend
                  formatter={(value) =>
                    value === 'commission' ? 'Commission' : 'Use Case Fees'
                  }
                />
                <Bar dataKey="commission" stackId="a" fill="hsl(var(--primary))" radius={[0, 0, 2, 2]} />
                <Bar dataKey="use_case_fees" stackId="a" fill="hsl(142 71% 45%)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Daily use case volume chart */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4 text-muted-foreground" />
            Daily AI Use Case Volume
          </CardTitle>
          <CardDescription>Cases resolved by AI without human intervention this month.</CardDescription>
        </CardHeader>
        <CardContent>
          {dailyQuery.isLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : (
            <ResponsiveContainer width="100%" height={192}>
              <LineChart data={daily} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="day"
                  tickFormatter={formatDay}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={28}
                />
                <Tooltip
                  formatter={(value) => {
                    const n = typeof value === 'number' ? value : Number(value);
                    return [Number.isFinite(n) ? n : 0, 'Cases'];
                  }}
                  labelFormatter={(label) => formatDay(String(label ?? ''))}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="hsl(142 71% 45%)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Recent AI use cases table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bot className="size-4 text-muted-foreground" />
            AI Use Cases
          </CardTitle>
          <CardDescription>
            Support conversations fully resolved by AI — no human intervention, no purchase.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {useCasesQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Contact</th>
                      <th className="px-4 py-3 font-medium">Resolved</th>
                      <th className="px-4 py-3 font-medium">Period</th>
                      <th className="px-4 py-3 font-medium">Fee</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                      <th className="px-4 py-3 font-medium sr-only">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(useCasesQuery.data?.rows ?? []).length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-4 py-8 text-center text-sm text-muted-foreground"
                        >
                          No AI use cases recorded yet.
                        </td>
                      </tr>
                    ) : (
                      (useCasesQuery.data?.rows ?? []).map((row) => (
                        <tr
                          key={row.id}
                          className="group border-b border-border/60 last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
                          onClick={() =>
                            setSelectedUseCase({
                              id: row.id,
                              conversation_id: row.conversation_id,
                              contact_name: row.contact_name,
                              resolved_at: row.resolved_at,
                              billing_period: row.billing_period,
                              fee_amount: row.fee_amount,
                              billing_status: row.status === 'voided' ? 'voided' : row.billing_status,
                            })
                          }
                        >
                          <td className="px-4 py-3 font-medium">{row.contact_name}</td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {new Date(row.resolved_at).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">
                            {row.billing_period ?? '—'}
                          </td>
                          <td className="px-4 py-3">
                            {row.fee_amount != null ? formatEur(row.fee_amount) : '—'}
                          </td>
                          <td className="px-4 py-3">
                            <UseCaseBillingBadge status={row.status === 'voided' ? 'voided' : row.billing_status} />
                          </td>
                          <td className="px-4 py-3">
                            <Link
                              to={`/inbox?c=${row.conversation_id}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground"
                              title="Open in Inbox"
                            >
                              <ExternalLink className="size-3.5" />
                              Inbox
                            </Link>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              {(useCasesQuery.data?.pagination?.totalPages ?? 0) > 1 ? (
                <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  <span>
                    Page {useCasesPage} of {useCasesQuery.data?.pagination?.totalPages}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-muted disabled:opacity-40"
                      disabled={useCasesPage <= 1}
                      onClick={() => setUseCasesPage((p) => p - 1)}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-muted disabled:opacity-40"
                      disabled={useCasesPage >= (useCasesQuery.data?.pagination?.totalPages ?? 1)}
                      onClick={() => setUseCasesPage((p) => p + 1)}
                      aria-label="Next page"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>

      {/* Billing history table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <FileText className="size-4 text-muted-foreground" />
            Billing History
          </CardTitle>
          <CardDescription>
            Finalized billing reports for past periods. Generated on the 1st of each month.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {billingHistoryQuery.isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="px-4 py-3 font-medium">Period</th>
                      <th className="px-4 py-3 font-medium">AI Orders</th>
                      <th className="px-4 py-3 font-medium">Commission</th>
                      <th className="px-4 py-3 font-medium">AI Cases</th>
                      <th className="px-4 py-3 font-medium">Use Case Fee</th>
                      <th className="px-4 py-3 font-medium">Total</th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(billingHistoryQuery.data?.rows ?? []).length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-4 py-8 text-center text-sm text-muted-foreground"
                        >
                          No billing history yet.
                        </td>
                      </tr>
                    ) : (
                      (billingHistoryQuery.data?.rows ?? []).map((row) => {
                        const start = new Date(row.period_start);
                        const end = new Date(row.period_end);
                        const periodLabel = `${start.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} – ${end.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`;
                        return (
                          <tr
                            key={row.id}
                            className="border-b border-border/60 last:border-0 hover:bg-muted/30 transition-colors"
                          >
                            <td className="px-4 py-3 font-medium">{periodLabel}</td>
                            <td className="px-4 py-3 text-muted-foreground">{row.total_orders}</td>
                            <td className="px-4 py-3">{formatEur(row.commission_amount)}</td>
                            <td className="px-4 py-3 text-muted-foreground">{row.use_case_count}</td>
                            <td className="px-4 py-3">{formatEur(row.use_case_amount)}</td>
                            <td className="px-4 py-3 font-semibold">{formatEur(row.total_amount)}</td>
                            <td className="px-4 py-3">
                              <BillingStatusBadge status={row.status} />
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              {(billingHistoryQuery.data?.pagination?.totalPages ?? 0) > 1 ? (
                <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
                  <span>
                    Page {billingHistoryPage} of {billingHistoryQuery.data?.pagination?.totalPages}
                  </span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-muted disabled:opacity-40"
                      disabled={billingHistoryPage <= 1}
                      onClick={() => setBillingHistoryPage((p) => p - 1)}
                      aria-label="Previous page"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="rounded p-1 hover:bg-muted disabled:opacity-40"
                      disabled={
                        billingHistoryPage >=
                        (billingHistoryQuery.data?.pagination?.totalPages ?? 1)
                      }
                      onClick={() => setBillingHistoryPage((p) => p + 1)}
                      aria-label="Next page"
                    >
                      <ChevronRight className="size-4" />
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
