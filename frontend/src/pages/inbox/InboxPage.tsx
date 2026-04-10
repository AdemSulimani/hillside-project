import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Inbox, Loader2, Lock, ShoppingBag, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { fetchOrders } from '@/api/ordersApi';
import {
  closeConversation,
  fetchConversationThread,
  fetchConversations,
  reopenConversation,
  sendConversationReply,
} from '@/api/conversationsApi';
import { ConversationListItem } from '@/components/inbox/ConversationListItem';
import { MessageBubble } from '@/components/inbox/MessageBubble';
import { ReplyBox } from '@/components/inbox/ReplyBox';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useRealtimeInbox } from '@/hooks/useRealtimeInbox';
import { useAuthStore } from '@/store/authStore';
import type { ReplyResult } from '@/api/conversationsApi';
import type { ChannelType, ConversationThread, InboxMessage } from '@/types/conversation';

const LIST_PAGE_SIZE = 25;

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

function isAiPaused(humanOverrideUntil: string | null): boolean {
  if (!humanOverrideUntil) return false;
  return new Date(humanOverrideUntil) > new Date();
}

export default function InboxPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const agentName = user?.name?.trim() || 'Agent';
  const [searchParams] = useSearchParams();
  const conversationFromUrl = searchParams.get('c') ?? searchParams.get('conversationId');

  const [channelFilter, setChannelFilter] = useState<ChannelType | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<'open' | 'closed'>('open');
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);

  useRealtimeInbox(selectedId);

  useEffect(() => {
    if (!conversationFromUrl) return;
    if (/^[0-9a-f-]{36}$/i.test(conversationFromUrl)) {
      setSelectedId(conversationFromUrl);
    }
  }, [conversationFromUrl]);

  const bottomAnchorRef = useRef<HTMLDivElement>(null);
  const lastScrolledMessageIdRef = useRef<string | null>(null);
  const loadOlderCooldownRef = useRef(false);

  useEffect(() => {
    void queryClient.invalidateQueries({ queryKey: ['conversations', 'unread-count'] });
  }, [queryClient]);

  const listQuery = useInfiniteQuery({
    queryKey: ['conversations', 'list', channelFilter, statusFilter],
    queryFn: ({ pageParam }) =>
      fetchConversations({
        page: pageParam,
        limit: LIST_PAGE_SIZE,
        channel: channelFilter === 'all' ? undefined : channelFilter,
        status: statusFilter,
      }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages
        ? last.pagination.page + 1
        : undefined,
  });

  const flatConversations = useMemo(
    () => listQuery.data?.pages.flatMap((p) => p.conversations) ?? [],
    [listQuery.data?.pages],
  );

  const filteredConversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return flatConversations;
    return flatConversations.filter((c) => {
      const name = c.contact_name.toLowerCase();
      const preview = (c.last_message_content ?? '').toLowerCase();
      return name.includes(q) || preview.includes(q);
    });
  }, [flatConversations, search]);

  const threadQuery = useQuery({
    queryKey: ['conversations', selectedId, 'detail'],
    queryFn: () => fetchConversationThread(selectedId!, {}),
    enabled: Boolean(selectedId),
  });

  const draftOrderQuery = useQuery({
    queryKey: ['orders', 'draft-for-conversation', selectedId],
    queryFn: () =>
      fetchOrders({
        conversation_id: selectedId!,
        status: 'draft',
        page: 1,
        limit: 1,
      }),
    enabled: Boolean(selectedId),
  });

  const draftOrderForThread = draftOrderQuery.data?.orders[0];

  const sendMutation = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => sendConversationReply(id, text),
    onMutate: async ({ id, text }) => {
      await queryClient.cancelQueries({ queryKey: ['conversations', id, 'detail'] });
      const prev = queryClient.getQueryData<ConversationThread>(['conversations', id, 'detail']);
      if (!prev) return { prev: undefined as ConversationThread | undefined };

      const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const optimistic: InboxMessage = {
        id: `optimistic-${Date.now()}`,
        tenant_id: prev.conversation.tenant_id,
        conversation_id: id,
        external_message_id: 'optimistic',
        direction: 'outbound',
        type: 'text',
        content: text,
        attachment_urls: [],
        sent_by: 'human',
        ai_processed: false,
        created_at: new Date().toISOString(),
      };

      queryClient.setQueryData<ConversationThread>(['conversations', id, 'detail'], {
        ...prev,
        conversation: { ...prev.conversation, human_override_until: until },
        messages: [...prev.messages, optimistic],
      });
      return { prev };
    },
    onError: (err, { id }, ctx) => {
      if (ctx?.prev) {
        queryClient.setQueryData(['conversations', id, 'detail'], ctx.prev);
      }
      toast.error(extractMessage(err, 'Failed to send message'));
    },
    onSuccess: (result: ReplyResult, { id }) => {
      queryClient.setQueryData<ConversationThread>(['conversations', id, 'detail'], (old) => {
        if (!old) return old;
        const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
        return {
          ...old,
          conversation: { ...old.conversation, human_override_until: until },
          messages: [
            ...old.messages.filter((m) => !String(m.id).startsWith('optimistic-')),
            result.message,
          ],
        };
      });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'unread-count'] });

      if (!result.channelDelivered) {
        toast.warning('Reply saved, but delivery to the channel failed (check credentials).');
      }
    },
  });

  const closeMutation = useMutation({
    mutationFn: closeConversation,
    onSuccess: (conv) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
      queryClient.setQueryData<ConversationThread>(['conversations', conv.id, 'detail'], (old) =>
        old ? { ...old, conversation: { ...old.conversation, status: conv.status } } : old,
      );
      toast.success('Conversation closed');
    },
    onError: (err) => toast.error(extractMessage(err, 'Failed to close conversation')),
  });

  const reopenMutation = useMutation({
    mutationFn: reopenConversation,
    onSuccess: (conv) => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', 'list'] });
      queryClient.setQueryData<ConversationThread>(['conversations', conv.id, 'detail'], (old) =>
        old ? { ...old, conversation: { ...old.conversation, status: conv.status } } : old,
      );
      toast.success('Conversation reopened');
    },
    onError: (err) => toast.error(extractMessage(err, 'Failed to reopen conversation')),
  });

  useEffect(() => {
    lastScrolledMessageIdRef.current = null;
  }, [selectedId]);

  const thread = threadQuery.data;
  const messages = thread?.messages ?? [];

  useLayoutEffect(() => {
    if (!selectedId || !thread) return;
    const last = messages[messages.length - 1];
    const lastId = last?.id ?? null;
    if (lastId && lastId !== lastScrolledMessageIdRef.current) {
      lastScrolledMessageIdRef.current = lastId;
      bottomAnchorRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [selectedId, thread, messages]);

  const loadOlder = useCallback(async () => {
    if (!selectedId || olderLoading) return;
    const current = queryClient.getQueryData<ConversationThread>([
      'conversations',
      selectedId,
      'detail',
    ]);
    if (!current?.pagination.hasMore || !current.pagination.nextCursor) return;

    setOlderLoading(true);
    try {
      const more = await fetchConversationThread(selectedId, {
        before: current.pagination.nextCursor,
        limit: 50,
      });
      queryClient.setQueryData<ConversationThread>(['conversations', selectedId, 'detail'], {
        conversation: current.conversation,
        messages: [...more.messages, ...current.messages],
        pagination: more.pagination,
      });
    } catch (err) {
      toast.error(extractMessage(err, 'Failed to load older messages'));
    } finally {
      setOlderLoading(false);
    }
  }, [olderLoading, queryClient, selectedId]);

  const handleScrollMessages = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollTop >= 48) return;
      if (!thread?.pagination.hasMore || olderLoading || loadOlderCooldownRef.current) return;
      loadOlderCooldownRef.current = true;
      void loadOlder().finally(() => {
        window.setTimeout(() => {
          loadOlderCooldownRef.current = false;
        }, 500);
      });
    },
    [loadOlder, olderLoading, thread?.pagination.hasMore],
  );

  const channelTabs: { key: ChannelType | 'all'; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'facebook', label: 'Facebook' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'whatsapp', label: 'WhatsApp' },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-4">
        <h1 className="text-xl font-semibold tracking-tight">Inbox</h1>
        <p className="text-sm text-muted-foreground">
          Read and reply to conversations across all connected channels.
        </p>
      </div>

      <div
        className={cn(
          'flex min-h-[min(720px,calc(100dvh-9rem))] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card',
          'lg:flex-row',
        )}
      >
        {/* Left: conversation list */}
        <div className="flex w-full flex-col border-b border-border lg:w-[min(100%,380px)] lg:border-r lg:border-b-0">
          <div className="border-b border-border p-3 space-y-3">
            <div className="relative">
              <Input
                placeholder="Search conversations…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pr-3"
              />
            </div>
            <div className="flex flex-wrap gap-1">
              {channelTabs.map(({ key, label }) => (
                <Button
                  key={key}
                  type="button"
                  size="xs"
                  variant={channelFilter === key ? 'default' : 'outline'}
                  onClick={() => setChannelFilter(key)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <div className="flex gap-1">
              <Button
                type="button"
                size="xs"
                variant={statusFilter === 'open' ? 'default' : 'outline'}
                onClick={() => setStatusFilter('open')}
              >
                Open
              </Button>
              <Button
                type="button"
                size="xs"
                variant={statusFilter === 'closed' ? 'default' : 'outline'}
                onClick={() => setStatusFilter('closed')}
              >
                Closed
              </Button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-2">
            {listQuery.isLoading ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-lg" />
                ))}
              </div>
            ) : listQuery.isError ? (
              <p className="p-3 text-sm text-destructive">Could not load conversations.</p>
            ) : filteredConversations.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">No conversations match your filters.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {filteredConversations.map((c) => (
                  <li key={c.id}>
                    <ConversationListItem
                      conversation={c}
                      selected={c.id === selectedId}
                      onSelect={() => setSelectedId(c.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {listQuery.hasNextPage ? (
              <div className="p-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => void listQuery.fetchNextPage()}
                >
                  {listQuery.isFetchingNextPage ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Loading…
                    </>
                  ) : (
                    'Load more'
                  )}
                </Button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Right: thread */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!selectedId ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <div className="rounded-full border border-dashed border-border p-4">
                <Inbox className="size-10 opacity-50" />
              </div>
              <div>
                <p className="font-medium text-foreground">Select a conversation</p>
                <p className="mt-1 max-w-sm text-sm">
                  Choose a thread on the left to view message history and send a reply.
                </p>
              </div>
            </div>
          ) : threadQuery.isLoading ? (
            <div className="flex flex-1 flex-col p-4 space-y-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-24 w-full max-w-md" />
              <Skeleton className="ml-auto h-16 w-full max-w-md" />
            </div>
          ) : threadQuery.isError || !thread ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-destructive">
              Could not load this conversation.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <h2 className="truncate font-semibold">{thread.conversation.contact_name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {thread.conversation.channel_name} ·{' '}
                    <span className="capitalize">{thread.conversation.channel_type}</span>
                    {thread.conversation.status === 'closed' ? (
                      <span className="ml-2 rounded-md bg-muted px-1.5 py-0.5">Closed</span>
                    ) : null}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {thread.conversation.status === 'open' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={closeMutation.isPending}
                      onClick={() => closeMutation.mutate(thread.conversation.id)}
                    >
                      <Lock className="size-4" />
                      Close
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={reopenMutation.isPending}
                      onClick={() => reopenMutation.mutate(thread.conversation.id)}
                    >
                      <Unlock className="size-4" />
                      Reopen
                    </Button>
                  )}
                </div>
              </div>

              {draftOrderForThread ? (
                <div className="border-b border-amber-500/25 bg-amber-500/10 px-4 py-3 dark:bg-amber-500/10">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex gap-3">
                      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-amber-500/20 text-amber-800 dark:text-amber-200">
                        <ShoppingBag className="size-5" aria-hidden />
                      </div>
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground">Order created</p>
                        <p className="text-sm text-muted-foreground">
                          A draft order exists for this conversation:{' '}
                          <span className="font-medium text-foreground">
                            {draftOrderForThread.product_name}
                          </span>
                          <span className="tabular-nums">
                            {' '}
                            · ${draftOrderForThread.total_price.toFixed(2)}
                          </span>
                        </p>
                      </div>
                    </div>
                    <Link
                      to={`/orders?open=${draftOrderForThread.id}`}
                      className={cn(
                        buttonVariants({ variant: 'secondary', size: 'sm' }),
                        'shrink-0 self-start sm:self-auto',
                      )}
                    >
                      Review in Orders
                    </Link>
                  </div>
                </div>
              ) : null}

              <div
                className="min-h-0 flex-1 overflow-y-auto px-4 py-3"
                onScroll={handleScrollMessages}
              >
                {olderLoading ? (
                  <div className="mb-2 flex justify-center">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : null}
                {thread.pagination.hasMore && !olderLoading ? (
                  <p className="mb-2 text-center text-xs text-muted-foreground">
                    Scroll up to load older messages
                  </p>
                ) : null}
                <div className="flex flex-col gap-3">
                  {messages.map((m) => (
                    <MessageBubble key={m.id} message={m} agentDisplayName={agentName} />
                  ))}
                </div>
                <div ref={bottomAnchorRef} className="h-px w-full shrink-0" aria-hidden />
              </div>

              <ReplyBox
                disabled={thread.conversation.status === 'closed'}
                disabledReason="This conversation is closed. Reopen it to send messages."
                aiPaused={isAiPaused(thread.conversation.human_override_until)}
                sending={sendMutation.isPending}
                onSend={async (text) => {
                  await sendMutation.mutateAsync({ id: thread.conversation.id, text });
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
