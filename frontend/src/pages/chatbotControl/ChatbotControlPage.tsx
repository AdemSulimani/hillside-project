import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Bot, Loader2, Radio } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchChatbotGlobalStatus,
  fetchPausedConversations,
  toggleChatbotGlobal,
} from '@/api/chatbotApi';
import { fetchChannels, toggleChannelAI } from '@/api/channelsApi';
import { toggleConversationAi } from '@/api/conversationsApi';
import { ChannelAiToggleRow } from '@/components/channels/ChannelAiToggleRow';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { Channel } from '@/types/channel';

const GLOBAL_STATUS_KEY = ['chatbot', 'global-status'] as const;
const PAUSED_KEY = ['chatbot', 'paused-conversations'] as const;
const CHANNELS_KEY = ['channels'] as const;

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

export default function ChatbotControlPage() {
  const queryClient = useQueryClient();

  const globalQuery = useQuery({
    queryKey: GLOBAL_STATUS_KEY,
    queryFn: fetchChatbotGlobalStatus,
  });

  const channelsQuery = useQuery({
    queryKey: CHANNELS_KEY,
    queryFn: fetchChannels,
  });

  const pausedQuery = useQuery({
    queryKey: PAUSED_KEY,
    queryFn: fetchPausedConversations,
  });

  const toggleGlobalMutation = useMutation({
    mutationFn: toggleChatbotGlobal,
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: GLOBAL_STATUS_KEY });
      const previous = queryClient.getQueryData<boolean>(GLOBAL_STATUS_KEY);
      queryClient.setQueryData<boolean>(GLOBAL_STATUS_KEY, (v) => !v);
      return { previous };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.previous !== undefined) {
        queryClient.setQueryData(GLOBAL_STATUS_KEY, ctx.previous);
      }
      toast.error(extractMessage(err, 'Përditësimi i cilësimit global të IA-së dështoi'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: GLOBAL_STATUS_KEY });
    },
    onSuccess: (isActive) => {
      toast.success(isActive ? 'IA-ja është aktive globalisht' : 'IA-ja është në pauzë globalisht');
    },
  });

  const toggleChannelMutation = useMutation({
    mutationFn: (id: string) => toggleChannelAI(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: CHANNELS_KEY });
      const previous = queryClient.getQueryData<Channel[]>(CHANNELS_KEY) ?? [];
      queryClient.setQueryData<Channel[]>(
        CHANNELS_KEY,
        previous.map((channel) =>
          channel.id === id ? { ...channel, ai_enabled: !channel.ai_enabled } : channel,
        ),
      );
      return { previous };
    },
    onError: (err, _id, context) => {
      queryClient.setQueryData(CHANNELS_KEY, context?.previous ?? []);
      toast.error(extractMessage(err, 'Përditësimi i IA-së për kanalin dështoi'));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: CHANNELS_KEY });
    },
  });

  const resumeConversationMutation = useMutation({
    mutationFn: (id: string) => toggleConversationAi(id),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: PAUSED_KEY });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', result.id, 'detail'] });
      toast.success('IA-ja u rifillua për këtë bisedë');
    },
    onError: (err) => {
      toast.error(extractMessage(err, 'Rifillimi i IA-së për bisedën dështoi'));
    },
  });

  const pendingChannelIds = useMemo(
    () =>
      new Set(toggleChannelMutation.isPending ? [toggleChannelMutation.variables] : []),
    [toggleChannelMutation.isPending, toggleChannelMutation.variables],
  );

  const isGlobalActive = globalQuery.data ?? false;
  const globalBusy = globalQuery.isLoading || toggleGlobalMutation.isPending;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Kontrolli i chatbot-it</h1>
        <p className="text-sm text-muted-foreground">
          Fikni IA-në për gjithë biznesin, për çdo kanal, ose pezullojeni vetëm për biseda të caktuara.
          Pauzat manuale mbeten kur e ktheni ndërprerësin global përsëri në aktiv.
        </p>
      </div>

      <Card className="overflow-hidden border-2">
        <CardHeader className="space-y-1 pb-2">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Bot className="size-5" />
            IA globale
          </CardTitle>
          <CardDescription>
            Kur është fikur, nuk dërgohen përgjigje të automatizuara askund derisa ta ndizni përsëri.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-2 pb-6">
          {globalQuery.isError ? (
            <p className="text-sm text-destructive">Statusi global i IA-së nuk u ngarkua.</p>
          ) : globalQuery.isLoading ? (
            <Skeleton className="h-14 w-full max-w-xl rounded-lg" />
          ) : (
            <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-2">
                <Label htmlFor="global-ai-switch" className="text-base font-medium">
                  Ndërprësësi kryesor
                </Label>
                <p
                  className={cn(
                    'inline-flex items-center rounded-md px-3 py-1.5 text-sm font-semibold',
                    isGlobalActive
                      ? 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-200'
                      : 'bg-destructive/15 text-destructive',
                  )}
                >
                  {isGlobalActive ? 'IA aktive' : 'IA në pauzë'}
                </p>
              </div>
              <div className="flex items-center gap-4 sm:pr-2">
                <span className="text-sm text-muted-foreground max-sm:hidden">
                  {isGlobalActive ? 'Automatizimi aktiv' : 'Automatizimi fikur'}
                </span>
                <div className="flex scale-125 origin-left sm:origin-right">
                  <Switch
                    id="global-ai-switch"
                    checked={isGlobalActive}
                    onCheckedChange={() => toggleGlobalMutation.mutate()}
                    disabled={globalBusy}
                    aria-label={isGlobalActive ? 'Fik IA-në globale' : 'Ndiz IA-në globale'}
                  />
                </div>
                {toggleGlobalMutation.isPending ? (
                  <Loader2 className="size-5 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Kanalet</h2>
          <p className="text-sm text-muted-foreground">
            Aktivizoni ose çaktivizoni IA-në për çdo kanal të lidhur (si te faqja Kanalet).
          </p>
        </div>

        {channelsQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-[4.5rem] w-full rounded-lg" />
            ))}
          </div>
        ) : channelsQuery.isError ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Kanalet nuk u ngarkuan. Ju lutemi rifreskoni faqen.
          </div>
        ) : channelsQuery.data?.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-12 text-center">
            <Radio className="size-9 text-muted-foreground opacity-50" />
            <p className="text-sm text-muted-foreground">Ende nuk është lidhur asnjë kanal.</p>
            <Link to="/channels" className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
              Shko te Kanalet
            </Link>
          </div>
        ) : (
          <div className="space-y-2 max-w-3xl">
            {channelsQuery.data!.map((channel) => (
              <ChannelAiToggleRow
                key={channel.id}
                channel={channel}
                isTogglePending={pendingChannelIds.has(channel.id)}
                onToggleAI={(c) => toggleChannelMutation.mutate(c.id)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Biseda në pauzë</h2>
          <p className="text-sm text-muted-foreground">
            Bisedat ku IA-ja u pezullua manualisht nga kutia e hyrjes ose nga kjo faqe.
          </p>
        </div>

        {pausedQuery.isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full rounded-lg" />
            ))}
          </div>
        ) : pausedQuery.isError ? (
          <p className="text-sm text-destructive">Bisedat në pauzë nuk u ngarkuan.</p>
        ) : !pausedQuery.data?.length ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            Aktualisht nuk ka biseda të pezulluara manualisht.
          </p>
        ) : (
          <ul className="space-y-2 max-w-3xl">
            {pausedQuery.data.map((row) => (
              <li key={row.id}>
                <Card>
                  <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="truncate font-medium">{row.contact_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.channel_name} ·{' '}
                        <span className="capitalize">{row.channel_type}</span>
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2">
                      <Link
                        to={`/inbox?c=${encodeURIComponent(row.id)}`}
                        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                      >
                        Hape në kutinë e hyrjes
                      </Link>
                      <Button
                        type="button"
                        size="sm"
                        disabled={resumeConversationMutation.isPending}
                        onClick={() => resumeConversationMutation.mutate(row.id)}
                      >
                        {resumeConversationMutation.isPending &&
                        resumeConversationMutation.variables === row.id ? (
                          <>
                            <Loader2 className="size-4 animate-spin" />
                            Duke rifilluar…
                          </>
                        ) : (
                          'Rifillo IA-në'
                        )}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
