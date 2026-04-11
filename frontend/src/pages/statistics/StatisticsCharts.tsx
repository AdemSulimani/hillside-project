import type { ReactNode } from 'react';
import type { TooltipContentProps } from 'recharts';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { MessageChartRow, OrderChartRow } from './chartHelpers';
import { formatChartTickDate } from './chartHelpers';

const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
];

const GRID_STROKE = 'var(--border)';
const AXIS_TICK = 'var(--muted-foreground)';

/** Matches Tailwind `h-72` (18rem); numeric height avoids Recharts 3 first-paint % sizing (-1×-1) warnings. */
const CHART_HEIGHT_PX = 288;

/** Positive initial size so Recharts never logs width(-1)/height(-1) before ResizeObserver (incl. React Strict Mode). */
const CHART_INITIAL_DIMENSION = { width: 640, height: CHART_HEIGHT_PX } as const;

function ChartShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-72 w-full min-h-[18rem] min-w-0 shrink-0" style={{ minHeight: CHART_HEIGHT_PX }}>
      {children}
    </div>
  );
}

function ChartTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <p className="mb-1 font-medium">{label != null ? String(label) : ''}</p>
      <ul className="space-y-0.5">
        {payload.map((p, i) => (
          <li key={`${String(p.name)}-${i}`} className="flex items-center gap-2">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            <span className="text-muted-foreground">{p.name}:</span>
            <span className="font-medium">
              {typeof p.value === 'number' ? p.value.toLocaleString() : String(p.value ?? '')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export interface StatisticsChartsProps {
  loading: boolean;
  messageRows: MessageChartRow[];
  orderRows: OrderChartRow[];
  pieRows: { name: string; value: number }[];
}

export function StatisticsCharts({ loading, messageRows, orderRows, pieRows }: StatisticsChartsProps) {
  const pieTotal = pieRows.reduce((s, r) => s + r.value, 0);

  if (loading) {
    return (
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl" />
        <Skeleton className="h-80 w-full rounded-xl lg:col-span-2" />
      </div>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Messages per day</CardTitle>
          <CardDescription>Total message activity (inbound, AI, and human replies) by UTC day.</CardDescription>
        </CardHeader>
        <CardContent className="pl-0">
          <ChartShell>
            <ResponsiveContainer
              width="100%"
              height={CHART_HEIGHT_PX}
              minWidth={0}
              initialDimension={CHART_INITIAL_DIMENSION}
            >
              <LineChart data={messageRows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: AXIS_TICK, fontSize: 11 }}
                tickFormatter={formatChartTickDate}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis tick={{ fill: AXIS_TICK, fontSize: 11 }} allowDecimals={false} width={36} />
              <Tooltip content={(props) => <ChartTooltip {...props} />} />
              <Line
                type="monotone"
                dataKey="total"
                name="Messages"
                stroke="var(--primary)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4 }}
              />
              </LineChart>
            </ResponsiveContainer>
          </ChartShell>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Orders per day</CardTitle>
          <CardDescription>Draft orders created vs orders confirmed (UTC day).</CardDescription>
        </CardHeader>
        <CardContent className="pl-0">
          <ChartShell>
            <ResponsiveContainer
              width="100%"
              height={CHART_HEIGHT_PX}
              minWidth={0}
              initialDimension={CHART_INITIAL_DIMENSION}
            >
              <BarChart data={orderRows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: AXIS_TICK, fontSize: 11 }}
                tickFormatter={formatChartTickDate}
                interval="preserveStartEnd"
                minTickGap={24}
              />
              <YAxis tick={{ fill: AXIS_TICK, fontSize: 11 }} allowDecimals={false} width={36} />
              <Tooltip content={(props) => <ChartTooltip {...props} />} />
              <Legend />
              <Bar dataKey="ordersCreated" name="Created" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="ordersConfirmed" name="Confirmed" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartShell>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inbound messages by channel</CardTitle>
          <CardDescription>Share of customer messages (message_received events) per channel.</CardDescription>
        </CardHeader>
        <CardContent>
          {pieTotal === 0 ? (
            <div className="flex h-72 min-h-[18rem] items-center justify-center">
              <p className="text-center text-sm text-muted-foreground">
                No channel data in this range yet. Inbound messages will appear here once analytics events
                accumulate.
              </p>
            </div>
          ) : (
            <ChartShell>
              <ResponsiveContainer
                width="100%"
                height={CHART_HEIGHT_PX}
                minWidth={0}
                initialDimension={CHART_INITIAL_DIMENSION}
              >
                <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <Pie
                    data={pieRows}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={52}
                    outerRadius={88}
                    paddingAngle={2}
                  >
                    {pieRows.map((_, i) => (
                      <Cell key={`cell-${i}`} fill={CHART_COLORS[i % CHART_COLORS.length]} stroke="transparent" />
                    ))}
                  </Pie>
                  <Tooltip content={(props) => <ChartTooltip {...props} />} />
                  <Legend verticalAlign="bottom" height={28} />
                </PieChart>
              </ResponsiveContainer>
            </ChartShell>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
