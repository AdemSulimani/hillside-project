import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  BarChart3,
  BrainCircuit,
  MessageSquare,
  Percent,
  ShoppingCart,
  Sparkles,
} from 'lucide-react';
import { fetchAIConfig } from '@/api/aiConfigApi';
import { fetchStatisticsSummary } from '@/api/statisticsApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthStore } from '@/store/authStore';
import {
  aiResponseRate,
  channelPieData,
  formatMoney,
  mergeDailyMessages,
  mergeDailyOrders,
  totalMessagesInSummary,
} from './chartHelpers';
import { formatYmdLocal, getRangeForPreset, utcDaysInclusive, type StatisticsPresetId } from './dateRangePresets';
import { StatisticsCharts } from './StatisticsCharts';
import { StatisticsDateRangeBar } from './StatisticsDateRangeBar';

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof MessageSquare;
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

export default function StatisticsPage() {
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);

  const [preset, setPreset] = useState<StatisticsPresetId>('last30');
  const initialRange = useMemo(() => getRangeForPreset('last30'), []);
  const [rangeStart, setRangeStart] = useState<Date>(initialRange.start);
  const [rangeEnd, setRangeEnd] = useState<Date>(initialRange.end);
  const [customStartYmd, setCustomStartYmd] = useState(() => formatYmdLocal(initialRange.start));
  const [customEndYmd, setCustomEndYmd] = useState(() => formatYmdLocal(initialRange.end));

  function handlePresetChange(id: StatisticsPresetId) {
    if (id === 'custom') {
      setPreset('custom');
      setCustomStartYmd(formatYmdLocal(rangeStart));
      setCustomEndYmd(formatYmdLocal(rangeEnd));
      return;
    }
    setPreset(id);
    const { start, end } = getRangeForPreset(id);
    setRangeStart(start);
    setRangeEnd(end);
  }

  function handleApplyCustom(start: Date, end: Date) {
    setPreset('custom');
    setRangeStart(start);
    setRangeEnd(end);
  }

  const statsQuery = useQuery({
    queryKey: ['statistics', 'summary', rangeStart.toISOString(), rangeEnd.toISOString()],
    queryFn: () =>
      fetchStatisticsSummary({
        startDate: rangeStart.toISOString(),
        endDate: rangeEnd.toISOString(),
      }),
    enabled: Boolean(tenantId),
  });

  const aiConfigQuery = useQuery({
    queryKey: ['ai-config'],
    queryFn: fetchAIConfig,
    enabled: Boolean(tenantId),
  });

  const summary = statsQuery.data;
  const loading = statsQuery.isLoading;
  const error = statsQuery.isError;

  const chartDays = useMemo(() => utcDaysInclusive(rangeStart, rangeEnd), [rangeStart, rangeEnd]);

  const messageRows = useMemo(
    () => (summary ? mergeDailyMessages(chartDays, summary.dailyMessages) : []),
    [summary, chartDays],
  );
  const orderRows = useMemo(
    () => (summary ? mergeDailyOrders(chartDays, summary.dailyOrders) : []),
    [summary, chartDays],
  );
  const pieRows = useMemo(() => (summary ? channelPieData(summary.channelBreakdown) : []), [summary]);

  const totalMessages = summary ? totalMessagesInSummary(summary) : 0;
  const aiRate = summary ? aiResponseRate(summary) : 0;
  const conversionPct = summary ? summary.conversionRate * 100 : 0;

  const modelLine = aiConfigQuery.data?.custom_model_id?.trim()
    ? `Modeli: ${aiConfigQuery.data.custom_model_id}`
    : 'Modeli: parazgjedhja e platformës';
  const assistantState = aiConfigQuery.data?.is_active ? 'Ndihmësi aktiv' : 'Ndihmësi në pauzë';

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <BarChart3 className="size-7 text-muted-foreground" />
          Statistika
        </h1>
        <p className="text-sm text-muted-foreground">
          Performanca e shitjeve, efektiviteti i IA-së dhe përzierja e kanaleve për periudhën që zgjidhni.
        </p>
      </div>

      <StatisticsDateRangeBar
        preset={preset}
        onPresetChange={handlePresetChange}
        rangeStart={rangeStart}
        rangeEnd={rangeEnd}
        onApplyCustom={handleApplyCustom}
        customStartYmd={customStartYmd}
        customEndYmd={customEndYmd}
        onCustomDraftChange={(patch) => {
          if (patch.start !== undefined) setCustomStartYmd(patch.start);
          if (patch.end !== undefined) setCustomEndYmd(patch.end);
        }}
        disabled={!tenantId}
      />

      {error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {extractMessage(statsQuery.error, 'Statistikat nuk u ngarkuan.')}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : (
          <>
            <KpiCard
              label="Mesazhe"
              icon={MessageSquare}
              value={totalMessages.toLocaleString()}
              sub="Hyrëse + IA + përgjigje njerëzore në interval"
            />
            <KpiCard
              label="Porosi"
              icon={ShoppingCart}
              value={(summary?.ordersCreated ?? 0).toLocaleString()}
              sub="Porosi skicë të krijuara në interval"
            />
            <KpiCard
              label="Shkalla e konvertimit"
              icon={Percent}
              value={`${conversionPct.toFixed(1)}%`}
              sub="Të konfirmuara ÷ të krijuara (i njëjti interval)"
            />
            <KpiCard
              label="Shkalla e përgjigjeve IA"
              icon={Sparkles}
              value={`${(aiRate * 100).toFixed(1)}%`}
              sub="Përgjigje IA ÷ (IA + njeri)"
            />
          </>
        )}
      </div>

      <StatisticsCharts loading={loading} messageRows={messageRows} orderRows={orderRows} pieRows={pieRows} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Produktet kryesore</CardTitle>
            <CardDescription>Sipas volumit të porosive dhe të ardhurave në këtë periudhë.</CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-40 w-full rounded-lg" />
            ) : !summary?.topProducts.length ? (
              <p className="text-sm text-muted-foreground">Ende nuk ka porosi me produkte në këtë interval.</p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[20rem] text-left text-sm">
                  <thead className="border-b border-border bg-muted/40">
                    <tr>
                      <th className="px-3 py-2 font-medium">Produkti</th>
                      <th className="px-3 py-2 font-medium text-right">Njësi</th>
                      <th className="px-3 py-2 font-medium text-right">Të ardhura</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.topProducts.map((row, idx) => (
                      <tr key={`${row.productId ?? 'np'}-${row.name}-${idx}`} className="border-b border-border/80 last:border-0">
                        <td className="px-3 py-2 font-medium">{row.name}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.unitsSold.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(row.revenue)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <BrainCircuit className="size-5 text-muted-foreground" />
              <CardTitle>Performanca e IA-së</CardTitle>
            </div>
            <CardDescription>Aktiviteti në intervalin e zgjedhur plus statusi aktual i modelit tuaj.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {loading ? (
              <Skeleton className="h-24 w-full rounded-lg" />
            ) : (
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2.5 dark:bg-muted/10">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Përgjigje IA</dt>
                  <dd className="text-xl font-semibold">{(summary?.aiReplies ?? 0).toLocaleString()}</dd>
                </div>
                <div className="rounded-lg border border-border/80 bg-muted/20 px-3 py-2.5 dark:bg-muted/10">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Komente (interval)
                  </dt>
                  <dd className="text-xl font-semibold">{(summary?.feedbackSubmitted ?? 0).toLocaleString()}</dd>
                </div>
              </dl>
            )}

            {aiConfigQuery.isLoading ? (
              <Skeleton className="h-16 w-full rounded-lg" />
            ) : aiConfigQuery.isError ? (
              <p className="text-sm text-muted-foreground">
                {extractMessage(aiConfigQuery.error, 'Konfigurimi i IA-së nuk u ngarkua.')}
              </p>
            ) : (
              <div className="rounded-lg border border-primary/15 bg-primary/[0.04] px-3 py-3 text-sm dark:bg-primary/10">
                <p className="font-medium text-foreground">{assistantState}</p>
                <p className="mt-1 text-muted-foreground">{modelLine}</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
