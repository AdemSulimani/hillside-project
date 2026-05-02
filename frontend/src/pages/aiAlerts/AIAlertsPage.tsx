import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Bell, Globe, Image, Loader2, MessageCircleMore, MoreHorizontal, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAIAlerts,
  fetchAIAlertsUnreadCount,
  markAIAlertRead,
  markAllAIAlertsRead,
  resolveAIAlert,
} from '@/api/aiAlertsApi';
import type { ChannelType } from '@/types/conversation';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { formatFlagReason } from '@/lib/aiAlertLabels';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { useAuthStore } from '@/store/authStore';
import type { AIAlertRow, AIAlertStatus } from '@/types/aiAlert';

const PAGE_SIZE = 20;

const ALERT_CHANNEL_ICONS: Record<ChannelType, LucideIcon> = {
  facebook: Globe,
  instagram: Image,
  whatsapp: MessageCircleMore,
};

type AlertsTab = 'open' | 'resolved';

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

function statusShortLabel(status: AIAlertStatus): string {
  if (status === 'unread') return 'E re';
  if (status === 'read') return 'E hapur';
  return 'E mbyllur';
}

function isCancellationOrRefundReason(reason: string): boolean {
  return reason === 'cancellation_request' || reason === 'refund_request';
}

function isUsageEscalationReason(reason: string): boolean {
  return reason === 'usage_question_unanswered';
}

export default function AIAlertsPage() {
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<AlertsTab>('open');
  const [page, setPage] = useState(1);
  const [resumeConfirmTarget, setResumeConfirmTarget] = useState<AIAlertRow | null>(null);

  const listQuery = useQuery({
    queryKey: ['ai-alerts', 'list', tab, page],
    queryFn: () =>
      fetchAIAlerts({
        page,
        limit: PAGE_SIZE,
        status: tab === 'open' ? 'open' : 'resolved',
      }),
    enabled: Boolean(tenantId),
  });

  const unreadCountQuery = useQuery({
    queryKey: ['ai-alerts', 'unread-count'],
    queryFn: fetchAIAlertsUnreadCount,
    enabled: Boolean(tenantId),
    refetchInterval: 120_000,
  });

  const invalidateAlertQueries = () => {
    void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['ai-alerts', 'unread-count'] });
    void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    void queryClient.invalidateQueries({ queryKey: ['orders', 'action-required'] });
  };

  const markReadMutation = useMutation({
    mutationFn: markAIAlertRead,
    onSuccess: () => {
      invalidateAlertQueries();
    },
    onError: (err) => toast.error(extractMessage(err, 'Nuk u përditësua alarmi')),
  });

  const markAllMutation = useMutation({
    mutationFn: markAllAIAlertsRead,
    onSuccess: (count) => {
      toast.success(
        count > 0
          ? `U shënuan ${count} alarm(e) si të lexuara (ende aktive derisa t’i mbyllni).`
          : 'Nuk ka alarme të reja për të shënuar.',
      );
      invalidateAlertQueries();
    },
    onError: (err) => toast.error(extractMessage(err, 'Nuk mund të shënohen të gjitha si të lexuara')),
  });

  const resolveMutation = useMutation({
    mutationFn: ({ id, resume_ai }: { id: string; resume_ai: boolean }) =>
      resolveAIAlert(id, { resume_ai }),
    onSuccess: (_, variables) => {
      toast.success(
        variables.resume_ai
          ? 'Alarmi u mbyll dhe IA-ja u rifillua për këtë bisedë.'
          : 'Alarmi u mbyll.',
      );
      setResumeConfirmTarget(null);
      invalidateAlertQueries();
    },
    onError: (err) => toast.error(extractMessage(err, 'Nuk mund të mbyllet alarmi')),
  });

  const alerts = listQuery.data?.alerts ?? [];
  const pagination = listQuery.data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;
  const openTotal = tab === 'open' ? pagination?.total : null;
  const resolvingId =
    resolveMutation.isPending && resolveMutation.variables
      ? resolveMutation.variables.id
      : null;

  return (
    <div className="space-y-6 pb-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Alarmet IA</h1>
          <p className="text-sm text-muted-foreground">
            Së pari përgjigjuni manualisht në bisedë. Kur të jetë zgjidhur çështja, kthehuni këtu:{' '}
            <strong>Mbyll alarmin</strong> ose, nëse doni që IA-ja të vazhdojë,{' '}
            <strong>Opsione</strong> → <strong>Mbyll dhe rifillo IA-në për bisedën</strong>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {typeof unreadCountQuery.data === 'number' && unreadCountQuery.data > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" variant="outline" size="sm" className="gap-1">
                    Më shumë veprime
                    <MoreHorizontal className="size-4 opacity-70" aria-hidden />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={markAllMutation.isPending}
                  onClick={() => markAllMutation.mutate()}
                >
                  Shëno të gjitha &quot;të reja&quot; si të lexuara
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        <Button
          type="button"
          size="sm"
          variant={tab === 'open' ? 'default' : 'outline'}
          onClick={() => {
            setTab('open');
            setPage(1);
          }}
        >
          {typeof openTotal === 'number' && openTotal > 0 ? (
            <span className="mr-1.5 inline-flex min-w-5 justify-center rounded-full bg-primary-foreground/20 px-1 text-[0.65rem] font-semibold tabular-nums">
              {openTotal > 99 ? '99+' : openTotal}
            </span>
          ) : typeof unreadCountQuery.data === 'number' && unreadCountQuery.data > 0 ? (
            <span className="mr-1.5 inline-flex min-w-5 justify-center rounded-full bg-primary-foreground/20 px-1 text-[0.65rem] font-semibold tabular-nums">
              {unreadCountQuery.data > 99 ? '99+' : unreadCountQuery.data}
            </span>
          ) : null}
          Në pritje
        </Button>
        <Button
          type="button"
          size="sm"
          variant={tab === 'resolved' ? 'default' : 'outline'}
          onClick={() => {
            setTab('resolved');
            setPage(1);
          }}
        >
          Histori
        </Button>
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
            {extractMessage(listQuery.error, 'Nuk u ngarkuan alarmet.')}
          </p>
        ) : alerts.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tab === 'open' ? 'Nuk ka alarme në pritje' : 'Nuk ka alarme të mbyllura'}
              </CardTitle>
              <CardDescription>
                {tab === 'open'
                  ? 'Kur ndodh diçka që kërkon vëmendje, do të shfaqet këtu.'
                  : 'Alarmet që keni mbyllur shfaqen këtu për referencë.'}
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <ul className="space-y-4">
            {alerts.map((alert) => {
              const ChannelIcon =
                ALERT_CHANNEL_ICONS[alert.channel_type] ?? MessageCircleMore;
              const showUsageDetails = isUsageEscalationReason(alert.reason);
              return (
                <li key={alert.id}>
                  <Card className={isCancellationOrRefundReason(alert.reason) ? 'border-red-500/40' : undefined}>
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
                        <Badge variant={statusBadgeVariant(alert.status)}>{statusShortLabel(alert.status)}</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{formatFlagReason(alert.reason)}</Badge>
                        {alert.quality_score != null ? (
                          <span className="text-xs text-muted-foreground tabular-nums">
                            Cilësia: {alert.quality_score.toFixed(2)}
                          </span>
                        ) : null}
                      </div>
                      <blockquote className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-foreground">
                        {alert.message_content?.trim() ? (
                          <p className="whitespace-pre-wrap break-words">{alert.message_content}</p>
                        ) : (
                          <span className="text-muted-foreground">(Pa tekst mesazhi)</span>
                        )}
                      </blockquote>
                      {showUsageDetails ? (
                        <div className="space-y-2">
                          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Pyetja e klientit
                            </p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                              {alert.customer_question?.trim() || alert.message_content?.trim() || '—'}
                            </p>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Produkti
                            </p>
                            <p className="mt-1 text-sm">{alert.product_name?.trim() || 'Produkt i panjohur'}</p>
                          </div>
                          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                              Udhëzimet aktuale të përdorimit
                            </p>
                            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                              {alert.usage_description?.trim() || 'Ende nuk janë vendosur udhëzime përdorimi.'}
                            </p>
                          </div>
                        </div>
                      ) : null}
                      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                        {tab === 'open' ? (
                          <>
                            <Button
                              type="button"
                              size="sm"
                              className="w-full sm:w-auto"
                              disabled={resolveMutation.isPending}
                              onClick={() =>
                                resolveMutation.mutate({ id: alert.id, resume_ai: false })
                              }
                            >
                              {resolvingId === alert.id ? (
                                <>
                                  <Loader2 className="size-4 animate-spin" aria-hidden />
                                  Duke mbyllur…
                                </>
                              ) : (
                                'Mbyll alarmin'
                              )}
                            </Button>
                            {alert.conversation_id ? (
                              <Link
                                to={`/inbox?c=${alert.conversation_id}`}
                                className={cn(
                                  buttonVariants({ variant: 'secondary', size: 'sm' }),
                                  'inline-flex w-full justify-center sm:w-auto',
                                )}
                              >
                                Shiko bisedën
                              </Link>
                            ) : null}
                            {alert.conversation_id ? (
                              <DropdownMenu>
                                <DropdownMenuTrigger
                                  render={
                                    <Button
                                      type="button"
                                      variant="outline"
                                      size="sm"
                                      className="w-full gap-1 sm:w-auto"
                                      disabled={resolveMutation.isPending}
                                    >
                                      Opsione
                                      <MoreHorizontal className="size-4 opacity-70" aria-hidden />
                                    </Button>
                                  }
                                />
                                <DropdownMenuContent align="start">
                                  <DropdownMenuItem
                                    onClick={() => setResumeConfirmTarget(alert)}
                                    disabled={resolveMutation.isPending}
                                  >
                                    Mbyll dhe rifillo IA-në për bisedën
                                  </DropdownMenuItem>
                                  {alert.status === 'unread' ? (
                                    <DropdownMenuItem
                                      onClick={() => markReadMutation.mutate(alert.id)}
                                      disabled={markReadMutation.isPending}
                                    >
                                      Shëno si të lexuar (pa e mbyllur)
                                    </DropdownMenuItem>
                                  ) : null}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            ) : null}
                          </>
                        ) : null}
                        {tab === 'resolved' && alert.conversation_id ? (
                          <div className="flex flex-wrap gap-2 sm:ml-auto">
                            <Link
                              to={`/inbox?c=${alert.conversation_id}`}
                              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'inline-flex')}
                            >
                              Shiko bisedën
                            </Link>
                          </div>
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
              E mëparshmja
            </Button>
            <span className="text-sm text-muted-foreground tabular-nums">
              Faqja {page} nga {totalPages}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages || listQuery.isFetching}
              onClick={() => setPage((p) => p + 1)}
            >
              Tjetra
            </Button>
          </div>
        ) : null}
      </div>

      <AlertDialog
        open={resumeConfirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setResumeConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rifilloni IA-në?</AlertDialogTitle>
            <AlertDialogDescription>
              Alarmi do të mbyllet dhe asistenti do të mund të përgjigjet përsëri automatikisht në këtë bisedë.
              Përdoreni vetëm nëse jeni gati që IA-ja të vazhdojë pa ndërhyrje njerëzore.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={resolveMutation.isPending}>Anulo</AlertDialogCancel>
            <AlertDialogAction
              disabled={resolveMutation.isPending || !resumeConfirmTarget}
              onClick={() => {
                if (!resumeConfirmTarget) return;
                resolveMutation.mutate({
                  id: resumeConfirmTarget.id,
                  resume_ai: true,
                });
              }}
            >
              {resolveMutation.isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Duke u përditësuar…
                </>
              ) : (
                'Po, mbyll dhe rifillo IA-në'
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {alerts.length === 0 && !listQuery.isLoading ? null : (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Bell className="size-3.5 shrink-0" aria-hidden />
          Numri në shiritin anësor tregon alarmet e palexuara; skeda &quot;Në pritje&quot; përfshin të gjitha që nuk janë
          mbyllur ende.
        </p>
      )}
    </div>
  );
}
