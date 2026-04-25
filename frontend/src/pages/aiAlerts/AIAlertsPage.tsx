import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Bell, Globe, Image, Loader2, MessageCircleMore, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAIAlerts,
  fetchUsageEscalations,
  fetchAIAlertsUnreadCount,
  markAIAlertRead,
  markAllAIAlertsRead,
  resolveAIAlert,
} from '@/api/aiAlertsApi';
import type { ChannelType } from '@/types/conversation';

const ALERT_CHANNEL_ICONS: Record<ChannelType, LucideIcon> = {
  facebook: Globe,
  instagram: Image,
  whatsapp: MessageCircleMore,
};
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { formatFlagReason } from '@/lib/aiAlertLabels';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { useAuthStore } from '@/store/authStore';
import type { AIAlertRow, AIAlertStatus } from '@/types/aiAlert';

const PAGE_SIZE = 20;

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

function statusBadgeVariant(
  status: AIAlertStatus,
): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (status === 'unread') return 'destructive';
  if (status === 'read') return 'secondary';
  return 'outline';
}

export default function AIAlertsPage() {
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AIAlertStatus | 'usage_escalations'>('unread');
  const [page, setPage] = useState(1);
  const [resolveTarget, setResolveTarget] = useState<AIAlertRow | null>(null);
  const [resumeAiOnResolve, setResumeAiOnResolve] = useState(false);

  const listQuery = useQuery({
    queryKey: ['ai-alerts', 'list', tab, page],
    queryFn: () =>
      tab === 'usage_escalations'
        ? fetchUsageEscalations({ page, limit: PAGE_SIZE })
        : fetchAIAlerts({ page, limit: PAGE_SIZE, status: tab }),
    enabled: Boolean(tenantId),
  });

  const unreadCountQuery = useQuery({
    queryKey: ['ai-alerts', 'unread-count'],
    queryFn: fetchAIAlertsUnreadCount,
    enabled: Boolean(tenantId),
    refetchInterval: 120_000,
  });

  const markReadMutation = useMutation({
    mutationFn: markAIAlertRead,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'unread-count'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
    },
    onError: (err) => toast.error(extractMessage(err, 'Could not update alert')),
  });

  const markAllMutation = useMutation({
    mutationFn: markAllAIAlertsRead,
    onSuccess: (count) => {
      toast.success(count > 0 ? `Marked ${count} alert(s) as read` : 'No unread alerts to update');
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'unread-count'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
    },
    onError: (err) => toast.error(extractMessage(err, 'Could not mark all as read')),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, resume_ai }: { id: string; resume_ai: boolean }) =>
      resolveAIAlert(id, { resume_ai }),
    onSuccess: () => {
      toast.success('Alert resolved');
      setResolveTarget(null);
      setResumeAiOnResolve(false);
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'unread-count'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    },
    onError: (err) => toast.error(extractMessage(err, 'Could not resolve alert')),
  });

  const alerts = listQuery.data?.alerts ?? [];
  const pagination = listQuery.data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">AI Alerts</h1>
          <p className="text-sm text-muted-foreground">
            When the assistant goes off-topic or replies with low confidence, you are notified here
            so you can take over the conversation.
          </p>
        </div>
        {tab === 'unread' ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={markAllMutation.isPending || (unreadCountQuery.data ?? 0) === 0}
            onClick={() => markAllMutation.mutate()}
          >
            {markAllMutation.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Marking…
              </>
            ) : (
              'Mark all as read'
            )}
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-1">
        {(['unread', 'read', 'resolved', 'usage_escalations'] as const).map((key) => (
          <Button
            key={key}
            type="button"
            size="sm"
            variant={tab === key ? 'default' : 'outline'}
            onClick={() => {
              setTab(key);
              setPage(1);
            }}
            className="capitalize"
          >
            {key === 'unread' && typeof unreadCountQuery.data === 'number' && unreadCountQuery.data > 0 ? (
              <span className="mr-1.5 inline-flex min-w-5 justify-center rounded-full bg-primary-foreground/20 px-1 text-[0.65rem] font-semibold tabular-nums">
                {unreadCountQuery.data > 99 ? '99+' : unreadCountQuery.data}
              </span>
            ) : null}
            {key === 'usage_escalations' ? 'Usage Escalations' : key}
          </Button>
        ))}
      </div>

      <div className="space-y-4">
        {listQuery.isLoading ? (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-40 w-full rounded-xl" />
            ))}
          </div>
        ) : listQuery.isError ? (
          <p className="text-sm text-destructive">
            {extractMessage(listQuery.error, 'Could not load alerts.')}
          </p>
        ) : alerts.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">No alerts</CardTitle>
              <CardDescription>Nothing in this tab yet.</CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <ul className="space-y-4">
            {alerts.map((alert) => {
              const ChannelIcon =
                ALERT_CHANNEL_ICONS[alert.channel_type] ?? MessageCircleMore;
              return (
                <li key={alert.id}>
                  <Card>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <div
                            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted"
                            title={alert.channel_type}
                          >
                            <ChannelIcon className="size-4 text-muted-foreground" aria-hidden />
                          </div>
                          <div className="min-w-0">
                            <CardTitle className="truncate text-base">{alert.contact_name}</CardTitle>
                            <CardDescription className="truncate">
                              {alert.channel_name} · {formatRelativeShort(alert.created_at)}
                            </CardDescription>
                          </div>
                        </div>
                        <Badge variant={statusBadgeVariant(alert.status)}>{alert.status}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{formatFlagReason(alert.reason)}</Badge>
                        {alert.quality_score != null ? (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            Quality score: {alert.quality_score.toFixed(2)}
                          </span>
                        ) : null}
                      </div>
                      <blockquote className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
                        {alert.message_content?.trim() ? (
                          <p className="whitespace-pre-wrap break-words">{alert.message_content}</p>
                        ) : (
                          <span className="text-muted-foreground">(No message text)</span>
                        )}
                      </blockquote>
                      {tab === 'usage_escalations' ? (
                        <div className="space-y-2">
                          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Customer Question
                            </p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                              {alert.customer_question?.trim() || alert.message_content?.trim() || '—'}
                            </p>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Product
                            </p>
                            <p className="mt-1 text-sm">{alert.product_name?.trim() || 'Unknown product'}</p>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Current Usage Description
                            </p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                              {alert.usage_description?.trim() || 'No usage instructions currently set.'}
                            </p>
                          </div>
                        </div>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        <Link
                          to={`/inbox?c=${alert.conversation_id}`}
                          className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }))}
                        >
                          View Conversation
                        </Link>
                        {tab === 'usage_escalations' ? (
                          alert.product_id ? (
                            <Link
                              to={`/products?edit=${encodeURIComponent(alert.product_id)}`}
                              className={cn(buttonVariants({ variant: 'default', size: 'sm' }))}
                            >
                              Update Usage Instructions
                            </Link>
                          ) : alert.product_name?.trim() ? (
                            <Link
                              to={`/products?editName=${encodeURIComponent(alert.product_name.trim())}`}
                              className={cn(buttonVariants({ variant: 'default', size: 'sm' }))}
                            >
                              Update Usage Instructions
                            </Link>
                          ) : (
                            <Button type="button" size="sm" variant="outline" disabled>
                              Update Usage Instructions
                            </Button>
                          )
                        ) : null}
                        {alert.status === 'unread' ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={markReadMutation.isPending}
                            onClick={() => markReadMutation.mutate(alert.id)}
                          >
                            Mark read
                          </Button>
                        ) : null}
                        {alert.status !== 'resolved' ? (
                          <Button
                            type="button"
                            size="sm"
                            disabled={resolveMutation.isPending}
                            onClick={() => {
                              setResumeAiOnResolve(false);
                              setResolveTarget(alert);
                            }}
                          >
                            Resolve
                          </Button>
                        ) : null}
                      </div>
                    </CardContent>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}

        {pagination && totalPages > 1 ? (
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1 || listQuery.isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages || listQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={resolveTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setResolveTarget(null);
            setResumeAiOnResolve(false);
          }
        }}
      >
        <DialogContent showCloseButton={!resolveMutation.isPending}>
          <DialogHeader>
            <DialogTitle>Resolve alert</DialogTitle>
            <DialogDescription>
              Mark this alert resolved. You can optionally turn the chatbot back on for this thread.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2">
            <span className="text-sm font-medium">Resume AI after resolve</span>
            <Switch checked={resumeAiOnResolve} onCheckedChange={setResumeAiOnResolve} />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={resolveMutation.isPending}
              onClick={() => setResolveTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={resolveMutation.isPending || !resolveTarget}
              onClick={() => {
                if (!resolveTarget) return;
                resolveMutation.mutate({
                  id: resolveTarget.id,
                  resume_ai: resumeAiOnResolve,
                });
              }}
            >
              {resolveMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Resolving…
                </>
              ) : (
                'Confirm'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {alerts.length === 0 && !listQuery.isLoading ? null : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bell className="size-3.5 shrink-0" aria-hidden />
          Unread badge in the sidebar updates in real time when new alerts arrive.
        </p>
      )}
    </div>
  );
}
