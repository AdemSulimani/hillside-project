import { useCallback, useEffect, useMemo, useState, memo, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { fetchChannels } from '@/api/channelsApi';
import { fetchContactDetail, updateContact } from '@/api/contactsApi';
import { ChannelTypeBadge } from '@/components/contacts/channelDisplay';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';
import { OrderStatusBadge } from '@/components/orders/orderStatusBadge';
import { orderChannelIcon } from '@/components/orders/orderChannelIcon';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { formatCurrency } from '@/lib/formatCurrency';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import type { Contact, ContactDetailPayload } from '@/types/contact';
import type { ChannelType } from '@/types/conversation';

const nameSchema = z.string().trim().min(1, 'Emri është i detyrueshëm').max(255);

const CONV_PAGE_SIZE = 10;
const ORDERS_PAGE_SIZE = 20;
const NOTES_DEBOUNCE_MS = 750;

const InternalNotesSection = memo(function InternalNotesSection({
  contactId,
  serverNotes,
  onUpdateCache,
}: {
  contactId: string;
  serverNotes: string | null;
  onUpdateCache: (contact: Contact) => void;
}) {
  const [notesDraft, setNotesDraft] = useState(serverNotes ?? '');
  const debouncedNotes = useDebouncedValue(notesDraft, NOTES_DEBOUNCE_MS);
  const skippedRef = useRef(true);

  const mutation = useMutation({
    mutationFn: (notes: string | null) => updateContact(contactId, { notes }),
    onSuccess: (updated) => {
      onUpdateCache(updated);
    },
    onError: () => {
      toast.error('Shënimet nuk u ruajtën');
    },
  });

  useEffect(() => {
    if (skippedRef.current) {
      skippedRef.current = false;
      return;
    }
    const nextNotes = debouncedNotes.trim() === '' ? null : debouncedNotes;
    const current = serverNotes ?? '';
    if ((nextNotes ?? '') === current) return;
    mutation.mutate(nextNotes);
  }, [debouncedNotes, serverNotes, contactId, mutation]);

  return (
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">Shënime të brendshme</h2>
        <p className="text-xs text-muted-foreground">
          Të dukshme vetëm për ekipin tuaj — klientët nuk i shohin kurrë.
        </p>
      </div>
      <Textarea
        value={notesDraft}
        onChange={(e) => setNotesDraft(e.target.value)}
        placeholder="p.sh. Preferon pagesë në dorëzim, banon në lagjen 5."
        className="min-h-[120px] resize-y"
        maxLength={20_000}
        aria-label="Shënime të brendshme"
      />
      <p className="text-xs text-muted-foreground">
        {debouncedNotes !== (serverNotes ?? '') && mutation.isPending
          ? 'Duke ruajtur…'
          : 'Shënimet ruhen automatikisht kur ndaloni së shkruari.'}
      </p>
    </section>
  );
});

function lastMessagePreview(messages: { content: string | null; type: string }[]): string {
  if (messages.length === 0) return 'Nuk ka mesazhe në pamje';
  const last = messages[messages.length - 1]!;
  const t = last.content?.trim();
  if (t) return t.length > 120 ? `${t.slice(0, 117)}…` : t;
  return last.type !== 'text' ? `(${last.type})` : '(Pa tekst)';
}

function renderOrderChannelIcon(channelType: Parameters<typeof orderChannelIcon>[0]) {
  const Icon = orderChannelIcon(channelType);
  return <Icon className="mx-auto size-4 text-muted-foreground" />;
}

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);
  const queryClient = useQueryClient();

  const [convPage, setConvPage] = useState(1);
  const [ordersPage, setOrdersPage] = useState(1);

  const { data: channels = [] } = useQuery({
    queryKey: ['channels', 'list', tenantId],
    queryFn: fetchChannels,
    enabled: Boolean(tenantId),
    staleTime: 5 * 60_000,
  });

  const channelById = useMemo(() => {
    const m = new Map<string, { type: ChannelType; name: string }>();
    for (const c of channels) {
      m.set(c.id, { type: c.type, name: c.name });
    }
    return m;
  }, [channels]);

  const detailQuery = useQuery({
    queryKey: ['contacts', 'detail', id, convPage, ordersPage],
    queryFn: () =>
      fetchContactDetail(id!, {
        conversations_page: convPage,
        conversations_limit: CONV_PAGE_SIZE,
        orders_page: ordersPage,
        orders_limit: ORDERS_PAGE_SIZE,
      }),
    enabled: Boolean(tenantId && id && /^[0-9a-f-]{36}$/i.test(id)),
  });

  const contact = detailQuery.data?.contact;

  const setDetailCache = useCallback(
    (updater: (prev: ContactDetailPayload) => ContactDetailPayload) => {
      queryClient.setQueryData<ContactDetailPayload>(
        ['contacts', 'detail', id, convPage, ordersPage],
        (prev) => (prev ? updater(prev) : prev),
      );
    },
    [queryClient, id, convPage, ordersPage],
  );

  const nameMutation = useMutation({
    mutationFn: (name: string) => updateContact(id!, { name }),
    onSuccess: (updated) => {
      setDetailCache((prev) => (prev ? { ...prev, contact: updated } : prev));
      queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });
    },
    onError: () => {
      toast.error('Emri nuk u ruajt');
    },
  });

  const handleNameBlur = (rawName: string, currentName: string) => {
    const parsed = nameSchema.safeParse(rawName);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Emër i pavlefshëm');
      return;
    }
    if (parsed.data === currentName) return;
    nameMutation.mutate(parsed.data);
  };

  const headerChannel = contact ? channelById.get(contact.channel_id) : undefined;
  const channelTypesOnRecord = useMemo(() => {
    const convs = detailQuery.data?.conversations.data ?? [];
    const uniq = new Set<ChannelType>();
    for (const c of convs) uniq.add(c.channel_type);
    if (headerChannel) uniq.add(headerChannel.type);
    return [...uniq];
  }, [detailQuery.data?.conversations.data, headerChannel]);

  if (!tenantId) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        Kontakt i pavlefshëm.
      </div>
    );
  }

  if (detailQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data || !contact) {
    return (
      <div className="space-y-4">
        <Link
          to="/contacts"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'inline-flex w-fit gap-1')}
        >
          <ArrowLeft className="size-4" />
          Kthehu te kontaktet
        </Link>
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Kontakti nuk u gjet ose nuk u ngarkua.
        </div>
      </div>
    );
  }

  const { conversations, orders } = detailQuery.data;

  return (
    <div className="space-y-8">
      <div>
        <Link
          to="/contacts"
          className={cn(
            buttonVariants({ variant: 'ghost', size: 'sm' }),
            'mb-4 inline-flex w-fit gap-1 text-muted-foreground',
          )}
        >
          <ArrowLeft className="size-4" />
          Kontakte
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <ContactAvatar
            name={contact.name}
            avatarUrl={contact.avatar_url}
            size="lg"
            className="shrink-0"
          />
          <div className="min-w-0 flex-1 space-y-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <Input
                key={contact.id}
                defaultValue={contact.name}
                onBlur={(e) => handleNameBlur(e.currentTarget.value, contact.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="h-10 max-w-md text-lg font-semibold"
                aria-label="Emri i kontaktit"
                disabled={nameMutation.isPending}
              />
              {nameMutation.isPending ? (
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {channelTypesOnRecord.map((t) => (
                <ChannelTypeBadge key={t} type={t} />
              ))}
            </div>
          </div>
        </div>
      </div>

      <Tabs defaultValue="conversations">
        <TabsList>
          <TabsTrigger value="conversations">Bisedat</TabsTrigger>
          <TabsTrigger value="orders">Porositë</TabsTrigger>
        </TabsList>

        <TabsContent value="conversations" className="space-y-4">
          {conversations.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nuk ka biseda për këtë kontakt.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {conversations.data.map((c) => (
                <li key={c.id}>
                  <Link
                    to={`/inbox?conversationId=${c.id}`}
                    className="block rounded-xl border border-border bg-card p-4 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <ChannelTypeBadge type={c.channel_type} />
                        <span className="text-xs text-muted-foreground">{c.channel_name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeShort(c.last_message_at)}
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                      {lastMessagePreview(c.messages)}
                    </p>
                    <span className="mt-2 inline-block text-xs font-medium text-primary">
                      Hape në Mesazhet →
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {conversations.pagination.totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={convPage <= 1}
                onClick={() => setConvPage((p) => Math.max(1, p - 1))}
              >
                Mëparshëm
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                Faqja {conversations.pagination.page} nga {conversations.pagination.totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={convPage >= conversations.pagination.totalPages}
                onClick={() => setConvPage((p) => p + 1)}
              >
                Tjetra
              </Button>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="orders">
          {orders.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nuk ka porosi për këtë kontakt.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead className="border-b border-border bg-muted/40">
                  <tr>
                    <th className="px-3 py-2 font-medium">Produkti</th>
                    <th className="px-3 py-2 font-medium">Sasia</th>
                    <th className="px-3 py-2 text-right font-medium">Totali</th>
                    <th className="px-3 py-2 text-center font-medium">Kan.</th>
                    <th className="px-3 py-2 font-medium">Statusi</th>
                    <th className="px-3 py-2 font-medium">Data</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.data.map((o) => {
                    return (
                      <tr key={o.id} className="border-b border-border last:border-0">
                        <td className="max-w-[200px] truncate px-3 py-2" title={o.product_name}>
                          {o.product_name}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{o.quantity}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">
                          {formatCurrency(o.total_price)}
                        </td>
                        <td className="px-3 py-2 text-center">
                          {renderOrderChannelIcon(o.channel_type)}
                        </td>
                        <td className="px-3 py-2">
                          <OrderStatusBadge status={o.status} />
                        </td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {formatRelativeShort(o.created_at)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {orders.pagination.totalPages > 1 ? (
            <div className="flex items-center justify-center gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={ordersPage <= 1}
                onClick={() => setOrdersPage((p) => Math.max(1, p - 1))}
              >
                Mëparshëm
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                Faqja {orders.pagination.page} nga {orders.pagination.totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={ordersPage >= orders.pagination.totalPages}
                onClick={() => setOrdersPage((p) => p + 1)}
              >
                Tjetra
              </Button>
            </div>
          ) : null}
        </TabsContent>
      </Tabs>

      <InternalNotesSection
        key={`${contact.id}:${contact.notes ?? ''}`}
        contactId={contact.id}
        serverNotes={contact.notes}
        onUpdateCache={(updated) => {
          setDetailCache((prev) => (prev ? { ...prev, contact: updated } : prev));
          queryClient.invalidateQueries({ queryKey: ['contacts', 'list'] });
        }}
      />
    </div>
  );
}
