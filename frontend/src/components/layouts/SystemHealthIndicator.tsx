import { useQuery } from '@tanstack/react-query';
import { fetchQueuesHealth } from '@/api/healthApi';
import { cn } from '@/lib/utils';

function buildTooltip(payload: Awaited<ReturnType<typeof fetchQueuesHealth>> | undefined, error: boolean): string {
  if (error) return 'Nuk u ngarkua statusi i radhës së punës.';
  if (!payload) return 'Duke ngarkuar statusin e radhës së punës…';

  const lines = payload.queues.map(
    (q) =>
      `${q.label}: thellësia ${q.depth} (pragu ${payload.depthWarningThreshold}), dështuar ${q.counts.failed}, punëtori ${q.worker.isRunning ? 'aktiv' : 'joaktiv'}`,
  );
  const head = payload.overallHealthy
    ? 'Të gjitha radhët brenda kufijve dhe punëtorët aktivë.'
    : 'Kujdes: mbipopullim ose problem punëtori në një ose më shumë radhë.';
  return [head, '', ...lines].join('\n');
}

export default function SystemHealthIndicator() {
  const { data, isError, isPending, isFetching } = useQuery({
    queryKey: ['queues-health'],
    queryFn: fetchQueuesHealth,
    refetchInterval: 30_000,
    retry: 1,
    staleTime: 15_000,
  });

  const status: 'loading' | 'green' | 'yellow' | 'gray' = isError
    ? 'gray'
    : isPending
      ? 'loading'
      : data?.overallHealthy
        ? 'green'
        : 'yellow';

  const tooltip = buildTooltip(data, isError);

  return (
    <div
      className="flex items-center gap-1.5"
      title={tooltip}
      aria-label={tooltip.replace(/\n/g, '. ')}
    >
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Sistemi
      </span>
      <span
        className={cn(
          'size-2 shrink-0 rounded-full ring-1 ring-background transition-colors',
          status === 'green' && 'bg-emerald-500',
          status === 'yellow' && 'bg-amber-400',
          status === 'gray' && 'bg-muted-foreground/45',
          status === 'loading' && 'animate-pulse bg-muted-foreground/35',
        )}
      />
      {isFetching && !isPending ? <span className="sr-only">Duke rifreskuar statusin e radhës</span> : null}
    </div>
  );
}
