import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { CheckCircle2, Loader2, RefreshCw, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAdminBusinesses,
  postAdminSyncAllCatalogBlocks,
  type AdminBusinessRow,
  type BulkCatalogSyncResult,
} from '@/api/platformAdminApi';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatCurrency } from '@/lib/formatCurrency';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 20;

function orderStatusVariant(
  s: 'unpaid' | 'billed' | 'paid' | 'clear',
): 'destructive' | 'secondary' | 'default' | 'outline' {
  if (s === 'unpaid') return 'destructive';
  if (s === 'billed') return 'secondary';
  if (s === 'paid') return 'default';
  return 'outline';
}

function useCaseStatusVariant(
  s: 'unbilled' | 'billed' | 'paid' | 'clear',
): 'destructive' | 'secondary' | 'default' | 'outline' {
  if (s === 'unbilled') return 'destructive';
  if (s === 'billed') return 'secondary';
  if (s === 'paid') return 'default';
  return 'outline';
}

function extractErr(e: unknown): string {
  return e instanceof AxiosError && e.response?.data?.message
    ? String(e.response.data.message)
    : 'Request failed';
}

// Fetches ALL businesses (unpaginated) for the sync selection dialog.
// Uses limit=100 (the API enforced maximum) and fans out pages in parallel.
async function fetchAllBusinessesForSync(): Promise<AdminBusinessRow[]> {
  const first = await fetchAdminBusinesses(1, 100);
  if (first.pagination.totalPages <= 1) return first.rows;
  const pages = await Promise.all(
    Array.from({ length: first.pagination.totalPages - 1 }, (_, i) =>
      fetchAdminBusinesses(i + 2, 100).then((r) => r.rows),
    ),
  );
  return [...first.rows, ...pages.flat()];
}

export default function AdminBusinessesPage() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'businesses', page],
    queryFn: () => fetchAdminBusinesses(page, PAGE_SIZE),
  });

  const rows = data?.rows ?? [];
  const totalPages = data?.pagination.totalPages ?? 1;
  const total = data?.pagination.total ?? 0;

  // —— Bulk sync dialog state ——
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncMode, setSyncMode] = useState<'all' | 'selected'>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [syncResult, setSyncResult] = useState<BulkCatalogSyncResult | null>(null);

  const allBusinessesQuery = useQuery({
    queryKey: ['admin', 'businesses', 'all-for-sync'],
    queryFn: fetchAllBusinessesForSync,
    enabled: syncOpen,
    staleTime: 60_000,
  });

  const allBusinesses = allBusinessesQuery.data ?? [];

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (selectedIds.size === allBusinesses.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allBusinesses.map((b) => b.tenant_id)));
    }
  }

  function openSync() {
    setSyncResult(null);
    setSyncMode('all');
    setSelectedIds(new Set());
    setSyncOpen(true);
  }

  const syncMutation = useMutation({
    mutationFn: () => {
      if (syncMode === 'all') return postAdminSyncAllCatalogBlocks();
      return postAdminSyncAllCatalogBlocks({ tenantIds: [...selectedIds] });
    },
    onSuccess: (d) => {
      setSyncResult(d);
      if (d.total_blocks_added > 0) {
        toast.success(`${d.total_blocks_added} guideline(s) distributed across ${d.tenants_updated} business(es)`);
      } else {
        toast.success('All businesses are already up to date');
      }
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const canSync = syncMode === 'all' || selectedIds.size > 0;
  const isBusy = syncMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Businesses</h1>
          <p className="text-sm text-muted-foreground">All tenants and commission exposure.</p>
        </div>
        <Button type="button" variant="outline" onClick={openSync}>
          <RefreshCw className="mr-2 size-4" />
          Sync AI guidelines
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium text-right">Orders</th>
                  <th className="px-4 py-3 font-medium text-right">AI orders</th>
                  <th className="px-4 py-3 font-medium text-right">Order commission</th>
                  <th className="px-4 py-3 font-medium">Order status</th>
                  <th className="px-4 py-3 font-medium text-right">Use cases</th>
                  <th className="px-4 py-3 font-medium text-right">UC fees owed</th>
                  <th className="px-4 py-3 font-medium">UC status</th>
                  <th className="px-4 py-3 font-medium text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b border-border">
                        <td className="px-4 py-3" colSpan={10}>
                          <Skeleton className="h-8 w-full" />
                        </td>
                      </tr>
                    ))
                  : isError
                    ? (
                        <tr>
                          <td className="px-4 py-8 text-center text-destructive" colSpan={10}>
                            Failed to load businesses.
                          </td>
                        </tr>
                      )
                    : rows.length === 0
                      ? (
                          <tr>
                            <td className="px-4 py-8 text-center text-muted-foreground" colSpan={10}>
                              No businesses yet.
                            </td>
                          </tr>
                        )
                      : (
                          rows.map((r) => (
                            <tr key={r.tenant_id} className="border-b border-border last:border-0">
                              <td className="px-4 py-3 font-medium">{r.business_name}</td>
                              <td className="px-4 py-3 text-muted-foreground capitalize">{r.plan}</td>
                              <td className="px-4 py-3 text-right tabular-nums">{r.total_orders}</td>
                              <td className="px-4 py-3 text-right tabular-nums">{r.total_ai_completed_orders}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-medium">
                                {formatCurrency(r.total_commission_owed)}
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant={orderStatusVariant(r.aggregate_commission_status)}>
                                  {r.aggregate_commission_status}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums">{r.total_use_cases}</td>
                              <td className="px-4 py-3 text-right tabular-nums font-medium">
                                {formatCurrency(r.total_use_case_fees_owed)}
                              </td>
                              <td className="px-4 py-3">
                                <Badge variant={useCaseStatusVariant(r.aggregate_use_case_billing_status)}>
                                  {r.aggregate_use_case_billing_status}
                                </Badge>
                              </td>
                              <td className="px-4 py-3 text-right">
                                <Link
                                  to={`/admin/businesses/${r.tenant_id}`}
                                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                                >
                                  View details
                                </Link>
                              </td>
                            </tr>
                          ))
                        )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {page} of {totalPages} ({total} total)
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>
      ) : null}

      {/* —— Bulk sync dialog —— */}
      <Dialog open={syncOpen} onOpenChange={(o) => { if (!isBusy) setSyncOpen(o); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Sync AI guidelines to businesses</DialogTitle>
            <p className="text-sm text-muted-foreground">
              Pushes any platform catalog blocks that were added after a business was onboarded.
              Existing guidelines — including any content you have customised — are never
              overwritten.
            </p>
          </DialogHeader>

          {/* Results panel shown after sync completes */}
          {syncResult !== null ? (
            <div className="space-y-3">
              <div className={cn(
                'flex items-start gap-2 rounded-md border px-3 py-3 text-sm',
                syncResult.total_blocks_added > 0
                  ? 'border-green-500/30 bg-green-500/5 text-green-800 dark:text-green-300'
                  : 'border-border bg-muted/30 text-muted-foreground',
              )}>
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                <div>
                  {syncResult.total_blocks_added > 0 ? (
                    <p className="font-medium">
                      {syncResult.total_blocks_added} guideline(s) distributed to{' '}
                      {syncResult.tenants_updated} business(es)
                    </p>
                  ) : (
                    <p>All businesses are already up to date — no new guidelines were added.</p>
                  )}
                </div>
              </div>

              {syncResult.details.length > 0 ? (
                <div className="rounded-md border border-border">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="px-3 py-2 text-left font-medium">Business</th>
                        <th className="px-3 py-2 text-left font-medium">Guidelines added</th>
                      </tr>
                    </thead>
                    <tbody>
                      {syncResult.details.map((d) => {
                        const business = allBusinesses.find((b) => b.tenant_id === d.tenant_id);
                        return (
                          <tr key={d.tenant_id} className="border-b border-border last:border-0">
                            <td className="px-3 py-2 font-medium">
                              {business?.business_name ?? d.tenant_id}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                              {d.added_block_keys.join(', ')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </div>
          ) : (
            /* Selection UI */
            <div className="space-y-4">
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setSyncMode('all')}
                  className={cn(
                    'flex-1 rounded-md border px-4 py-3 text-left text-sm transition-colors',
                    syncMode === 'all'
                      ? 'border-primary bg-primary/5 font-medium text-primary'
                      : 'border-border hover:bg-muted/40',
                  )}
                >
                  <p className="font-medium">All businesses</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Sync every business in the system at once
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setSyncMode('selected')}
                  className={cn(
                    'flex-1 rounded-md border px-4 py-3 text-left text-sm transition-colors',
                    syncMode === 'selected'
                      ? 'border-primary bg-primary/5 font-medium text-primary'
                      : 'border-border hover:bg-muted/40',
                  )}
                >
                  <p className="font-medium">Specific businesses</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Choose which businesses to update
                  </p>
                </button>
              </div>

              {syncMode === 'selected' ? (
                <div className="space-y-2">
                  {allBusinessesQuery.isLoading ? (
                    <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      Loading businesses…
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between">
                        <p className="text-xs text-muted-foreground">
                          {selectedIds.size} of {allBusinesses.length} selected
                        </p>
                        <button
                          type="button"
                          onClick={toggleAll}
                          className="text-xs text-primary underline-offset-2 hover:underline"
                        >
                          {selectedIds.size === allBusinesses.length ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>
                      <div className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border">
                        {allBusinesses.map((b) => (
                          <label
                            key={b.tenant_id}
                            className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-muted/30"
                          >
                            <input
                              type="checkbox"
                              className="size-4 rounded border-input accent-primary"
                              checked={selectedIds.has(b.tenant_id)}
                              onChange={() => toggleSelected(b.tenant_id)}
                            />
                            <span className="font-medium">{b.business_name}</span>
                            <span className="ml-auto text-xs text-muted-foreground capitalize">{b.plan}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setSyncOpen(false)}
              disabled={isBusy}
            >
              <X className="mr-1.5 size-4" />
              {syncResult !== null ? 'Close' : 'Cancel'}
            </Button>
            {syncResult === null ? (
              <Button
                type="button"
                onClick={() => syncMutation.mutate()}
                disabled={isBusy || !canSync}
              >
                {isBusy
                  ? <Loader2 className="mr-2 size-4 animate-spin" />
                  : <RefreshCw className="mr-2 size-4" />}
                {syncMode === 'all'
                  ? 'Sync all businesses'
                  : `Sync ${selectedIds.size} business${selectedIds.size !== 1 ? 'es' : ''}`}
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => { setSyncResult(null); setSyncMode('all'); setSelectedIds(new Set()); }}
              >
                Sync again
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
