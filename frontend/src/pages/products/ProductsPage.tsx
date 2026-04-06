import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ChevronDown,
  Loader2,
  Package,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { deleteProduct, fetchProducts } from '@/api/productsApi';
import { cn } from '@/lib/utils';
import type { Product } from '@/types/product';
import { ProductsUIProvider, useProductsUI } from '@/contexts/ProductsUIContext';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ProductCard } from '@/components/products/ProductCard';
import { ProductFormDrawer } from '@/components/products/ProductFormDrawer';
import { ProductUploadSheet } from '@/components/products/ProductUploadSheet';
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
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

const PAGE_SIZE = 12;

function ProductsPageInner() {
  const queryClient = useQueryClient();
  const {
    openManualCreate,
    openEdit,
    closeForm,
    formOpen,
    formMode,
    formProduct,
    openUpload,
    closeUpload,
    uploadOpen,
    uploadKind,
  } = useProductsUI();

  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  const listQueryKey = useMemo(
    () =>
      ['products', { search: debouncedSearch, tags: tagFilter || undefined, page }] as const,
    [debouncedSearch, tagFilter, page],
  );

  const { data, isLoading, isFetching, isError } = useQuery({
    queryKey: listQueryKey,
    queryFn: () =>
      fetchProducts({
        search: debouncedSearch || undefined,
        tags: tagFilter || undefined,
        page,
        limit: PAGE_SIZE,
      }),
  });

  const { data: tagOptions = [] } = useQuery({
    queryKey: ['product-tags'],
    queryFn: async () => {
      const { products } = await fetchProducts({ page: 1, limit: 200 });
      const s = new Set<string>();
      products.forEach((p) => p.tags.forEach((t) => s.add(t)));
      return Array.from(s).sort((a, b) => a.localeCompare(b));
    },
    staleTime: 60_000,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProduct(id),
    onMutate: async (id) => {
      await queryClient.cancelQueries({ queryKey: ['products'] });
      const previous = queryClient.getQueriesData<{ products: Product[]; pagination: { total: number; totalPages: number; page: number; limit: number } }>({
        queryKey: ['products'],
      });
      previous.forEach(([key, cached]) => {
        if (!cached?.products) return;
        queryClient.setQueryData(key, {
          ...cached,
          products: cached.products.filter((p) => p.id !== id),
          pagination: {
            ...cached.pagination,
            total: Math.max(0, cached.pagination.total - 1),
            totalPages: Math.max(
              1,
              Math.ceil(Math.max(0, cached.pagination.total - 1) / PAGE_SIZE),
            ),
          },
        });
      });
      setDeleteTarget(null);
      return { previous };
    },
    onError: (err, _id, ctx) => {
      ctx?.previous.forEach(([key, data]) => {
        if (data !== undefined) queryClient.setQueryData(key, data);
      });
      const msg =
        err instanceof AxiosError && err.response?.data?.message
          ? String(err.response.data.message)
          : 'Could not delete product';
      toast.error(msg);
    },
    onSuccess: () => {
      toast.success('Product removed');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['product-tags'] });
    },
  });

  const products = data?.products ?? [];
  const pagination = data?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Products</h1>
          <p className="text-sm text-muted-foreground">
            Manage your catalog — search, filter by tag, or import from files.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button className="gap-1 self-start sm:self-auto">
                New product
                <ChevronDown className="size-4 opacity-70" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onClick={openManualCreate}>Fill manually</DropdownMenuItem>
            <DropdownMenuItem onClick={() => openUpload('document')}>Attach document</DropdownMenuItem>
            <DropdownMenuItem onClick={() => openUpload('image')}>Attach image</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(1);
            }}
            placeholder="Search name, description, SKU, category…"
            className="h-10 pl-9"
            aria-label="Search products"
          />
          {isFetching && searchInput && (
            <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-2 sm:w-56">
          <label htmlFor="tag-filter" className="sr-only">
            Filter by tag
          </label>
          <select
            id="tag-filter"
            value={tagFilter}
            onChange={(e) => {
              setTagFilter(e.target.value);
              setPage(1);
            }}
            className={cn(
              'h-10 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none transition-colors',
              'focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
            )}
          >
            <option value="">All tags</option>
            {tagOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-80 rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
          Could not load products. Please refresh.
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Package className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">No products match your filters.</p>
          <Button type="button" variant="outline" size="sm" onClick={openManualCreate}>
            Create your first product
          </Button>
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onEdit={openEdit}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>

          {pagination && pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
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
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      <ProductFormDrawer
        open={formOpen}
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
        mode={formMode}
        product={formProduct}
      />

      <ProductUploadSheet
        open={uploadOpen}
        onOpenChange={(o) => {
          if (!o) closeUpload();
        }}
        kind={uploadKind}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete product?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes “{deleteTarget?.name}” from your catalog. You can restore from the database if
              needed; the app hides soft-deleted items.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export default function ProductsPage() {
  return (
    <ProductsUIProvider>
      <ProductsPageInner />
    </ProductsUIProvider>
  );
}
