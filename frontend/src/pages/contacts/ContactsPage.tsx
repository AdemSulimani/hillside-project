import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, Search, Users } from 'lucide-react';
import { fetchChannels } from '@/api/channelsApi';
import { fetchContacts } from '@/api/contactsApi';
import { ChannelTypeBadge } from '@/components/contacts/channelDisplay';
import { ContactAvatar } from '@/components/contacts/ContactAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
import type { ContactListItem, ContactListSortColumn } from '@/types/contact';
import type { ChannelType } from '@/types/conversation';

const PAGE_SIZE = 20;

export default function ContactsPage() {
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);
  const navigate = useNavigate();
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'last_seen', desc: true }]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const sortForApi = useMemo(() => {
    const s = sorting[0];
    if (!s) return { sort: 'last_seen' as ContactListSortColumn, sort_dir: 'desc' as const };
    return {
      sort: s.id as ContactListSortColumn,
      sort_dir: s.desc ? ('desc' as const) : ('asc' as const),
    };
  }, [sorting]);

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

  const listQuery = useQuery({
    queryKey: ['contacts', 'list', tenantId, page, debouncedSearch, sortForApi.sort, sortForApi.sort_dir],
    queryFn: () =>
      fetchContacts({
        page,
        limit: PAGE_SIZE,
        search: debouncedSearch.trim() || undefined,
        sort: sortForApi.sort,
        sort_dir: sortForApi.sort_dir,
      }),
    enabled: Boolean(tenantId),
  });

  const contacts = listQuery.data?.contacts ?? [];
  const pagination = listQuery.data?.pagination;

  const columns = useMemo<ColumnDef<ContactListItem>[]>(
    () => [
      {
        id: 'name',
        accessorKey: 'name',
        header: ({ column }) => (
          <button
            type="button"
            onClick={column.getToggleSortingHandler()}
            className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
          >
            Contact
            {column.getIsSorted() === 'desc' ? (
              <ArrowDown className="size-3.5 opacity-70" />
            ) : column.getIsSorted() === 'asc' ? (
              <ArrowUp className="size-3.5 opacity-70" />
            ) : (
              <ArrowUpDown className="size-3.5 opacity-40" />
            )}
          </button>
        ),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <ContactAvatar
              name={row.original.name}
              avatarUrl={row.original.avatar_url}
              size="sm"
            />
            <span className="font-medium">{row.original.name}</span>
          </div>
        ),
      },
      {
        id: 'channel',
        enableSorting: false,
        header: 'Channel',
        cell: ({ row }) => {
          const ch = channelById.get(row.original.channel_id);
          const type = ch?.type ?? 'whatsapp';
          return <ChannelTypeBadge type={type} className="text-xs" />;
        },
      },
      {
        id: 'message_count',
        accessorKey: 'message_count',
        header: ({ column }) => (
          <button
            type="button"
            onClick={column.getToggleSortingHandler()}
            className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
          >
            Messages
            {column.getIsSorted() === 'desc' ? (
              <ArrowDown className="size-3.5 opacity-70" />
            ) : column.getIsSorted() === 'asc' ? (
              <ArrowUp className="size-3.5 opacity-70" />
            ) : (
              <ArrowUpDown className="size-3.5 opacity-40" />
            )}
          </button>
        ),
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">{row.original.message_count}</span>
        ),
      },
      {
        id: 'order_count',
        accessorKey: 'order_count',
        header: ({ column }) => (
          <button
            type="button"
            onClick={column.getToggleSortingHandler()}
            className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
          >
            Orders
            {column.getIsSorted() === 'desc' ? (
              <ArrowDown className="size-3.5 opacity-70" />
            ) : column.getIsSorted() === 'asc' ? (
              <ArrowUp className="size-3.5 opacity-70" />
            ) : (
              <ArrowUpDown className="size-3.5 opacity-40" />
            )}
          </button>
        ),
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">{row.original.order_count}</span>
        ),
      },
      {
        id: 'last_seen',
        accessorKey: 'last_seen',
        header: ({ column }) => (
          <button
            type="button"
            onClick={column.getToggleSortingHandler()}
            className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
          >
            Last seen
            {column.getIsSorted() === 'desc' ? (
              <ArrowDown className="size-3.5 opacity-70" />
            ) : column.getIsSorted() === 'asc' ? (
              <ArrowUp className="size-3.5 opacity-70" />
            ) : (
              <ArrowUpDown className="size-3.5 opacity-40" />
            )}
          </button>
        ),
        cell: ({ row }) => {
          const iso = row.original.last_seen;
          return (
            <span
              className="text-muted-foreground"
              title={iso ? new Date(iso).toLocaleString() : undefined}
            >
              {iso ? formatRelativeShort(iso) : '—'}
            </span>
          );
        },
      },
    ],
    [channelById],
  );

  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data: contacts,
    columns,
    state: {
      sorting,
      pagination: { pageIndex: page - 1, pageSize: PAGE_SIZE },
    },
    manualPagination: true,
    manualSorting: true,
    pageCount: pagination?.totalPages ?? 0,
    onSortingChange: (updater) => {
      setSorting((prev) => (typeof updater === 'function' ? updater(prev) : updater));
      setPage(1);
    },
    onPaginationChange: (updater) => {
      setPage((p) => {
        const prev = { pageIndex: p - 1, pageSize: PAGE_SIZE };
        const next = typeof updater === 'function' ? updater(prev) : updater;
        return next.pageIndex + 1;
      });
    },
    getCoreRowModel: getCoreRowModel(),
  });

  if (!tenantId) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Contacts</h1>
        <p className="text-sm text-muted-foreground">
          Everyone who has contacted your business, with activity and order count.
        </p>
      </div>

      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search by name..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          className="h-10 pl-9"
          aria-label="Search contacts"
        />
      </div>

      {listQuery.isLoading ? (
        <Skeleton className="h-96 w-full rounded-xl" />
      ) : listQuery.isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Contacts could not be loaded. Please refresh.
        </div>
      ) : contacts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Users className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">
            {debouncedSearch.trim()
              ? 'No contacts match your search.'
              : 'No contacts yet. They appear when customers message your channels.'}
          </p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-border bg-muted/40">
                {table.getHeaderGroups().map((hg) => (
                  <tr key={hg.id}>
                    {hg.headers.map((header) => (
                      <th key={header.id} className="px-3 py-3">
                        {header.isPlaceholder
                          ? null
                          : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => (
                  <tr
                    key={row.id}
                    role="link"
                    tabIndex={0}
                    aria-label={`Open contact ${row.original.name}`}
                    className={cn(
                      'border-b border-border last:border-0 hover:bg-muted/30',
                      'cursor-pointer outline-none focus-visible:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                    )}
                    onClick={() => navigate(`/contacts/${row.original.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/contacts/${row.original.id}`);
                      }
                    }}
                  >
                    {row.getVisibleCells().map((cell) => (
                      <td key={cell.id} className="px-3 py-2.5">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    ))}
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
                onClick={() => table.previousPage()}
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
                onClick={() => table.nextPage()}
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
