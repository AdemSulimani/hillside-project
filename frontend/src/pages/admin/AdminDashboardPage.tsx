import { useQuery } from '@tanstack/react-query';
import {
  Bar,
  BarChart,
  CartesianGrid,
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
                      Commission earned (all time)
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
                      Unpaid commission
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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Commission earned by month</CardTitle>
          <p className="text-sm text-muted-foreground">
            Based on commissionable orders that reached confirmed status (UTC months).
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
                  tickFormatter={(v) => `$${v}`}
                  tick={{ fontSize: 11 }}
                  className="fill-muted-foreground"
                />
                <Tooltip
                  formatter={(value) => {
                    const n = typeof value === 'number' ? value : Number(value);
                    return [formatCurrency(Number.isFinite(n) ? n : 0), 'Commission'];
                  }}
                  labelFormatter={(_, p) => p?.[0]?.payload?.month_key ?? ''}
                />
                <Bar dataKey="commission" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
