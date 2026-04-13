import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  deleteAdminCommissionReport,
  fetchAdminCommissionReportsAll,
  patchAdminCommissionReport,
  type CommissionReportRow,
} from '@/api/platformAdminApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
import { formatCurrency } from '@/lib/formatCurrency';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 20;

const STATUS_OPTIONS: CommissionReportRow['status'][] = ['unpaid', 'billed', 'paid'];

function formatDate(d: string) {
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return d;
  }
}

const selectClass =
  'h-8 min-w-[108px] rounded-md border border-input bg-background px-2 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50';

export default function AdminCommissionReportsPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CommissionReportRow | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'commission-reports', page],
    queryFn: () => fetchAdminCommissionReportsAll(page, PAGE_SIZE),
  });

  const rows = data?.rows ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;

  useEffect(() => {
    if (!isLoading && rows.length === 0 && page > 1) {
      setPage((p) => Math.max(1, p - 1));
    }
  }, [isLoading, rows.length, page]);

  const patchMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: CommissionReportRow['status'] }) =>
      patchAdminCommissionReport(id, { status }),
    onMutate: ({ id }) => setUpdatingId(id),
    onSettled: () => setUpdatingId(null),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'commission-reports'] });
      toast.success('Report status updated');
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Update failed' : 'Update failed');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdminCommissionReport(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'commission-reports'] });
      toast.success('Report deleted');
      setDeleteTarget(null);
    },
    onError: (e) => {
      toast.error(e instanceof AxiosError ? (e.response?.data?.message as string) ?? 'Delete failed' : 'Delete failed');
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Commission reports</h1>
        <p className="text-sm text-muted-foreground">All generated reports across businesses.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Period</th>
                  <th className="px-4 py-3 font-medium text-right">Orders</th>
                  <th className="px-4 py-3 font-medium text-right">Revenue</th>
                  <th className="px-4 py-3 font-medium text-right">Commission</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td className="px-4 py-8" colSpan={8}>
                      <Skeleton className="h-8 w-full" />
                    </td>
                  </tr>
                ) : isError ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-destructive" colSpan={8}>
                      Failed to load reports.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={8}>
                      No reports generated yet.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.id} className="border-b border-border last:border-0">
                      <td className="px-4 py-3 font-medium">{r.business_name}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {formatDate(r.period_start)} — {formatDate(r.period_end)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{r.total_orders}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(r.total_revenue)}</td>
                      <td className="px-4 py-3 text-right tabular-nums font-medium">
                        {formatCurrency(r.commission_amount)}
                      </td>
                      <td className="px-4 py-3">
                        <select
                          className={selectClass}
                          value={r.status}
                          disabled={updatingId === r.id}
                          aria-label={`Status for report ${r.id}`}
                          onChange={(e) => {
                            const status = e.target.value as CommissionReportRow['status'];
                            if (status !== r.status) {
                              patchMutation.mutate({ id: r.id, status });
                            }
                          }}
                        >
                          {STATUS_OPTIONS.map((s) => (
                            <option key={s} value={s}>
                              {s.charAt(0).toUpperCase() + s.slice(1)}
                            </option>
                          ))}
                        </select>
                        {updatingId === r.id ? (
                          <Loader2 className="ml-2 inline size-4 animate-spin text-muted-foreground" aria-hidden />
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          aria-label="Delete report"
                          onClick={() => setDeleteTarget(r)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete commission report?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the saved report for{' '}
              <span className="font-medium text-foreground">{deleteTarget?.business_name}</span> (
              {deleteTarget ? `${formatDate(deleteTarget.period_start)} — ${formatDate(deleteTarget.period_end)}` : ''}
              ). Order commission statuses are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
              }}
            >
              {deleteMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            Page {pagination?.page} of {totalPages} ({pagination?.total} total)
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
    </div>
  );
}
