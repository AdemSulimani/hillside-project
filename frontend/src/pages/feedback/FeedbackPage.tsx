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
  return status === 'pending' ? 'Në pritje' : 'Përfshirë në trajnim';
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
  { key: 'all', label: 'Të gjitha' },
  { key: 'pending', label: 'Në pritje', filter: 'pending' },
  { key: 'included_in_training', label: 'Të përfshira', filter: 'included_in_training' },
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
        <h1 className="text-2xl font-semibold tracking-tight">Komente për IA-në</h1>
        <p className="text-sm text-muted-foreground">
          Shënoni përgjigjet e gabuara të IA-së në Mesazhet dhe ndiqni korrigjimet për trajnim të mëtejshëm.
        </p>
      </div>

      <div className="grid gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center gap-2">
              <MessageSquareHeart className="size-5 text-muted-foreground" />
              <CardTitle>Progresi i mbledhjes</CardTitle>
            </div>
            <CardDescription>Elemente komentesh të regjistruara për hapësirën tuaj të punës.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {configQuery.isLoading ? (
              <Skeleton className="h-10 w-full rounded-lg" />
            ) : configQuery.isError ? (
              <p className="text-sm text-destructive">
                {extractMessage(configQuery.error, 'Nuk u ngarkua progresi.')}
              </p>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">
                  <span className="text-2xl font-semibold tabular-nums">{feedbackCount}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {' '}
                    / {target} komente të mbledhura
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
                    aria-label="Progresi i mbledhjes së komenteve"
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
          {extractMessage(listQuery.error, 'Nuk u ngarkuan regjistrat e komenteve.')}
        </div>
      ) : logs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <MessageSquareHeart className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">
            Ende nuk ka komente. Përdorni butonin “thumb down” në një mesazh IA në Mesazhet.
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40">
                <tr>
                  <th className="px-3 py-3 font-medium">Përgjigja origjinale e IA-së</th>
                  <th className="px-3 py-3 font-medium">Përgjigja e korrigjuar</th>
                  <th className="px-3 py-3 font-medium">Arsyeja</th>
                  <th className="px-3 py-3 font-medium">Statusi</th>
                  <th className="px-3 py-3 font-medium">Data</th>
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
              Duke përditësuar…
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
                E mëparshmja
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                Faqja {pagination.page} nga {pagination.totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Tjetra
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
