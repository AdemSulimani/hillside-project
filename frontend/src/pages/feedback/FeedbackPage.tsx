import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2, MessageSquareHeart } from 'lucide-react';
import { feedbackReasonDisplay } from '@/components/inbox/feedbackOptions';
import { fetchAIConfig } from '@/api/aiConfigApi';
import { fetchFeedbackLogs } from '@/api/feedbackApi';
import { FEEDBACK_FINETUNING_COLLECTION_TARGET } from '@/constants/feedbackFinetuning';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { useAuthStore } from '@/store/authStore';
import type { FeedbackLogStatus } from '@/types/feedback';

const PAGE_SIZE = 20;

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

function statusBadgeVariant(status: FeedbackLogStatus): 'secondary' | 'default' {
  return status === 'pending' ? 'secondary' : 'default';
}

function statusLabel(status: FeedbackLogStatus): string {
  return status === 'pending' ? 'Pending' : 'Included in training';
}

function CellText({ text, empty = '—' }: { text: string | null | undefined; empty?: string }) {
  const s = text?.trim();
  if (!s) return <span className="text-muted-foreground">{empty}</span>;
  return (
    <span className="line-clamp-3 max-w-[min(100%,20rem)]" title={s}>
      {s}
    </span>
  );
}

const STATUS_TABS: { key: 'all' | FeedbackLogStatus; label: string; filter?: FeedbackLogStatus }[] = [
  { key: 'all', label: 'All' },
  { key: 'pending', label: 'Pending', filter: 'pending' },
  { key: 'included_in_training', label: 'Included', filter: 'included_in_training' },
];

export default function FeedbackPage() {
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);
  const [statusTab, setStatusTab] = useState<(typeof STATUS_TABS)[number]['key']>('all');
  const [page, setPage] = useState(1);

  const statusFilter = useMemo(() => {
    const tab = STATUS_TABS.find((t) => t.key === statusTab);
    return tab?.filter;
  }, [statusTab]);

  const configQuery = useQuery({
    queryKey: ['ai-config'],
    queryFn: fetchAIConfig,
    enabled: Boolean(tenantId),
  });

  const listQuery = useQuery({
    queryKey: ['feedback-logs', page, statusFilter],
    queryFn: () =>
      fetchFeedbackLogs({
        page,
        limit: PAGE_SIZE,
        status: statusFilter,
      }),
    enabled: Boolean(tenantId),
  });

  const feedbackCount = configQuery.data?.feedback_count ?? 0;
  const target = FEEDBACK_FINETUNING_COLLECTION_TARGET;
  const progressPct = Math.min(100, Math.round((feedbackCount / target) * 100));

  const logs = listQuery.data?.logs ?? [];
  const pagination = listQuery.data?.pagination;

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI Feedback</h1>
        <p className="text-sm text-muted-foreground">
          Mark incorrect AI replies in Inbox and track corrections for future training.
        </p>
      </div>

      <div className="grid gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <MessageSquareHeart className="size-5 text-muted-foreground" />
              <CardTitle>Collection progress</CardTitle>
            </div>
            <CardDescription>Feedback items collected for your workspace.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {configQuery.isLoading ? (
              <Skeleton className="h-10 w-full rounded-lg" />
            ) : configQuery.isError ? (
              <p className="text-sm text-destructive">
                {extractMessage(configQuery.error, 'Progress could not be loaded.')}
              </p>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">
                  <span className="text-2xl font-semibold tabular-nums">{feedbackCount}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {' '}
                    / {target} feedback items collected
                  </span>
                </p>
                <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${progressPct}%` }}
                    role="progressbar"
                    aria-valuenow={feedbackCount}
                    aria-valuemin={0}
                    aria-valuemax={target}
                    aria-label="Feedback collection progress"
                  />
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => (
          <Button
            key={tab.key}
            type="button"
            size="sm"
            variant={statusTab === tab.key ? 'default' : 'outline'}
            onClick={() => {
              setStatusTab(tab.key);
              setPage(1);
            }}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : listQuery.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          {extractMessage(listQuery.error, 'Feedback logs could not be loaded.')}
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <MessageSquareHeart className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">
            No feedback yet. Use the "thumb down" button on an AI message in Inbox.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  <th className="px-3 py-3 font-medium">Original AI response</th>
                  <th className="px-3 py-3 font-medium">Corrected response</th>
                  <th className="px-3 py-3 font-medium">Reason</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row) => (
                  <tr key={row.id} className="border-b border-border last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2.5 align-top">
                      <CellText text={row.original_ai_response} />
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <CellText text={row.corrected_response} empty="—" />
                    </td>
                    <td className="px-3 py-2.5 align-top text-muted-foreground">
                      <span
                        className="line-clamp-3 max-w-[min(100%,20rem)]"
                        title={row.reason ?? undefined}
                      >
                        {feedbackReasonDisplay(row.reason)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <Badge variant={statusBadgeVariant(row.status)}>{statusLabel(row.status)}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted-foreground">
                      <span title={new Date(row.created_at).toLocaleString()}>
                        {formatRelativeShort(row.created_at)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {listQuery.isFetching ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Updating...
            </div>
          ) : null}

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
    </div>
  );
}
