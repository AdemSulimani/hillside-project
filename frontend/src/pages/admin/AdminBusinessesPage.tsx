import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchAdminBusinesses } from '@/api/platformAdminApi';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { formatCurrency } from '@/lib/formatCurrency';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 20;

function aggregateStatusVariant(
  s: 'unpaid' | 'billed' | 'paid' | 'clear',
): 'destructive' | 'secondary' | 'default' | 'outline' {
  if (s === 'unpaid') return 'destructive';
  if (s === 'billed') return 'secondary';
  if (s === 'paid') return 'default';
  return 'outline';
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Businesses</h1>
        <p className="text-sm text-muted-foreground">All tenants and commission exposure.</p>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left">
                  <th className="px-4 py-3 font-medium">Business</th>
                  <th className="px-4 py-3 font-medium">Plan</th>
                  <th className="px-4 py-3 font-medium text-right">Orders</th>
                  <th className="px-4 py-3 font-medium text-right">AI orders</th>
                  <th className="px-4 py-3 font-medium text-right">Commission owed</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium text-right"> </th>
                </tr>
              </thead>
              <tbody>
                {isLoading
                  ? Array.from({ length: 6 }).map((_, i) => (
                      <tr key={i} className="border-b border-border">
                        <td className="px-4 py-3" colSpan={7}>
                          <Skeleton className="h-8 w-full" />
                        </td>
                      </tr>
                    ))
                  : isError
                    ? (
                        <tr>
                          <td className="px-4 py-8 text-center text-destructive" colSpan={7}>
                            Failed to load businesses.
                          </td>
                        </tr>
                      )
                    : rows.length === 0
                      ? (
                          <tr>
                            <td className="px-4 py-8 text-center text-muted-foreground" colSpan={7}>
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
                                <Badge variant={aggregateStatusVariant(r.aggregate_commission_status)}>
                                  {r.aggregate_commission_status}
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
    </div>
  );
}
