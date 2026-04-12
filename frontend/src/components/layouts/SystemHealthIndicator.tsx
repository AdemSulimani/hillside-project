import { useQuery } from '@tanstack/react-query';
import { fetchQueuesHealth } from '@/api/healthApi';
import { cn } from '@/lib/utils';

function buildTooltip(payload: Awaited<ReturnType<typeof fetchQueuesHealth>> | undefined, error: boolean): string {
  if (error) return 'Could not load job queue status.';
  if (!payload) return 'Loading job queue status…';

  const lines = payload.queues.map(
    (q) =>
      `${q.label}: depth ${q.depth} (threshold ${payload.depthWarningThreshold}), failed ${q.counts.failed}, worker ${q.worker.isRunning ? 'up' : 'down'}`,
  );
  const head = payload.overallHealthy
    ? 'All queues within limits and workers running.'
    : 'Attention: backlog or worker issue on one or more queues.';
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
        System
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
      {isFetching && !isPending ? <span className="sr-only">Refreshing queue status</span> : null}
    </div>
  );
}
