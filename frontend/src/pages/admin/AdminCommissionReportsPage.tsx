import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAdminCommissionReportsAll } from '@/api/platformAdminApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/formatCurrency';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 20;

function reportStatusVariant(s: string): 'destructive' | 'secondary' | 'default' {
  if (s === 'unpaid') return 'destructive';
  if (s === 'billed') return 'secondary';
  return 'default';
}

function formatDate(d: string) {
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return d;
  }
}

export default function AdminCommissionReportsPage() {
  const [page, setPage] = useState(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['admin', 'commission-reports', page],
    queryFn: () => fetchAdminCommissionReportsAll(page, PAGE_SIZE),
  });

  const rows = data?.rows ?? [];
  const pagination = data?.pagination;
  const totalPages = pagination?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Commission reports</h1>
        <p className="text-sm text-muted-foreground">All generated reports across businesses.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Period</th>
                  <th className="px-4 py-3 font-medium text-right">Orders</th>
                  <th className="px-4 py-3 font-medium text-right">Revenue</th>
                  <th className="px-4 py-3 font-medium text-right">Commission</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td className="px-4 py-8" colSpan={7}>
                      <Skeleton className="h-8 w-full" />
                    </td>
                  </tr>
                ) : isError ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-destructive" colSpan={7}>
                      Failed to load reports.
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
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
                        <Badge variant={reportStatusVariant(r.status)}>{r.status}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{new Date(r.created_at).toLocaleString()}</td>
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
