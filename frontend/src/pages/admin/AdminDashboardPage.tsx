import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fetchAdminCommissionByMonth, fetchAdminDashboardSummary } from '@/api/platformAdminApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonCard } from '@/components/ui/skeleton';
import { formatCurrency } from '@/lib/formatCurrency';

function monthLabel(monthKey: string): string {
  const [y, m] = monthKey.split('-').map(Number);
  if (!y || !m) return monthKey;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function AdminDashboardPage() {
  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['admin', 'dashboard', 'summary'],
    queryFn: fetchAdminDashboardSummary,
  });

  const { data: series = [], isLoading: chartLoading } = useQuery({
    queryKey: ['admin', 'dashboard', 'commission-by-month'],
    queryFn: fetchAdminCommissionByMonth,
  });

  const chartData = series.map((p) => ({
    ...p,
    label: monthLabel(p.month_key),
  }));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">Platform-wide commission overview.</p>
      </div>

      {/* AI order commission summary */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          AI order commissions (5%)
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {summaryLoading
            ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            : (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Total businesses
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{summary?.total_businesses ?? 0}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        AI-completed orders (all time)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">{summary?.total_ai_completed_orders ?? 0}</p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Order commission earned (all time)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">
                        {formatCurrency(summary?.total_commission_earned ?? 0)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-amber-500/40 bg-amber-500/5">
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-amber-900 dark:text-amber-200">
                        Unpaid order commission
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">
                        {formatCurrency(summary?.total_unpaid_commission ?? 0)}
                      </p>
                    </CardContent>
                  </Card>
                </>
              )}
        </div>
      </div>

      {/* AI use case fee summary */}
      <div>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          AI use case fees (progressive tiers)
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {summaryLoading
            ? Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)
            : (
                <>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Completed use cases (all time)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">
                        {summary?.total_ai_completed_use_cases ?? 0}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-blue-500/30 bg-blue-500/5">
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-blue-900 dark:text-blue-200">
                        Pending billing
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold text-blue-700 dark:text-blue-400">
                        {summary?.total_unbilled_use_cases ?? 0}
                      </p>
                      <p className="mt-1 text-xs text-blue-700/70 dark:text-blue-400/70">
                        Fee calculated at month-end
                      </p>
                    </CardContent>
                  </Card>
                  <Card>
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-muted-foreground">
                        Use case fees earned (all time)
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold">
                        {formatCurrency(summary?.total_use_case_fees_earned ?? 0)}
                      </p>
                    </CardContent>
                  </Card>
                  <Card className="border-amber-500/40 bg-amber-500/5">
                    <CardHeader>
                      <CardTitle className="text-sm font-medium text-amber-900 dark:text-amber-200">
                        Unpaid use case fees
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-2xl font-bold text-amber-700 dark:text-amber-400">
                        {formatCurrency(summary?.total_unpaid_use_case_fees ?? 0)}
                      </p>
                    </CardContent>
                  </Card>
                </>
              )}
        </div>
      </div>

      {/* Combined revenue chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Revenue by month</CardTitle>
          <p className="text-sm text-muted-foreground">
            Order commissions (5%) and billed use case fees — UTC calendar months.
          </p>
        </CardHeader>
        <CardContent className="h-80 pt-2">
          {chartLoading ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading chart…
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} className="fill-muted-foreground" />
                <YAxis
                  tickFormatter={(v) => formatCurrency(Number(v))}
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                />
                <Tooltip
                  formatter={(value, name) => {
                    const n = typeof value === 'number' ? value : Number(value);
                    const label =
                      name === 'commission' ? 'Order commission' : 'Use case fees';
                    return [formatCurrency(Number.isFinite(n) ? n : 0), label];
                  }}
                  labelFormatter={(_, p) => p?.[0]?.payload?.month_key ?? ''}
                />
                <Legend
                  formatter={(value) =>
                    value === 'commission' ? 'Order commission (5%)' : 'Use case fees'
                  }
                />
                <Bar
                  dataKey="commission"
                  stackId="revenue"
                  fill="hsl(var(--primary))"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="use_case_fees"
                  stackId="revenue"
                  fill="hsl(var(--primary) / 0.45)"
                  radius={[4, 4, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
