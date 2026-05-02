import { useMemo, useState } from 'react';
import { useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  ChevronDown,
  Loader2,
  Package,
  Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { deleteProduct, fetchProduct, fetchProductTags, fetchProducts } from '@/api/productsApi';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/store/authStore';
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
  const tenantId = useAuthStore((s) => s.user?.tenant_id ?? null);
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
  const [searchParams, setSearchParams] = useSearchParams();

  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [tagFilter, setTagFilter] = useState('');
  const [page, setPage] = useState(1);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);

  useEffect(() => {
    const editId = searchParams.get('edit');
    const editName = searchParams.get('editName');
    if (!editId && !editName) return;
    if (!tenantId) return;
    const isUuid = editId ? /^[0-9a-f-]{36}$/i.test(editId) : false;
    if (!isUuid && !editName) return;

    let cancelled = false;
    void (async () => {
      try {
        let product: Product | null = null;
        if (editId && isUuid) {
          product = await fetchProduct(editId);
        } else if (editName?.trim()) {
          const query = editName.trim();
          const result = await fetchProducts({ search: query, page: 1, limit: 50 });
          const normalize = (s: string) => s.trim().toLowerCase();
          const exact = result.products.find((p) => normalize(p.name) === normalize(query));
          product = exact ?? result.products[0] ?? null;
        }
        if (!product) {
          throw new Error('No matching product found');
        }
        if (cancelled) return;
        openEdit(product);
      } catch {
        if (!cancelled) {
          toast.error('Nuk mund të hapet ai produkt për redaktim');
        }
      } finally {
        if (!cancelled) {
          const next = new URLSearchParams(searchParams);
          next.delete('edit');
          next.delete('editName');
          setSearchParams(next, { replace: true });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, setSearchParams, tenantId, openEdit]);

  const listQueryKey = useMemo(
    () =>
      [
        'products',
        tenantId,
        { search: debouncedSearch, tags: tagFilter || undefined, page },
      ] as const,
    [tenantId, debouncedSearch, tagFilter, page],
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
    enabled: Boolean(tenantId),
  });

  const { data: tagOptions = [] } = useQuery({
    queryKey: ['product-tags', tenantId],
    queryFn: () => fetchProductTags(),
    staleTime: 60_000,
    enabled: Boolean(tenantId),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProduct(id),
    onMutate: async (id) => {
      if (!tenantId) return { previous: [] as [readonly unknown[], unknown][] };
      await queryClient.cancelQueries({ queryKey: ['products', tenantId] });
      const previous = queryClient.getQueriesData<{
        products: Product[];
        pagination: { total: number; totalPages: number; page: number; limit: number };
      }>({
        queryKey: ['products', tenantId],
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
          : 'Nuk u fshi produkti';
      toast.error(msg);
    },
    onSuccess: () => {
      toast.success('Produkti u hoq');
    },
    onSettled: () => {
      if (tenantId) {
        queryClient.invalidateQueries({ queryKey: ['products', tenantId] });
        queryClient.invalidateQueries({ queryKey: ['product-tags', tenantId] });
      }
    },
  });

  const products = data?.products ?? [];
  const pagination = data?.pagination;

  if (!tenantId) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-80 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Produkte</h1>
          <p className="text-sm text-muted-foreground">
            Menaxhoni katalogun — kërkoni, filtroni sipas etiketës ose importoni nga skedarët.
          </p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button className="gap-1 self-start sm:self-auto">
                Produkt i ri
                <ChevronDown className="size-4 opacity-70" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem onClick={openManualCreate}>Plotëso manualisht</DropdownMenuItem>
            <DropdownMenuItem onClick={() => openUpload('document')}>Bashkëngjit dokument</DropdownMenuItem>
            <DropdownMenuItem onClick={() => openUpload('image')}>Bashkëngjit imazh</DropdownMenuItem>
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
            placeholder="Kërko emër, markë, përshkrim, SKU, kategori…"
            className="h-10 pl-9"
            aria-label="Kërko produkte"
          />
          {isFetching && searchInput && (
            <Loader2 className="absolute right-2.5 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-2 sm:w-56">
          <label htmlFor="tag-filter" className="sr-only">
            Filtro sipas etiketës
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
            <option value="">Të gjitha etiketat</option>
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
          Nuk u ngarkuan produktet. Ju lutemi rifreskoni.
        </div>
      ) : products.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-center">
          <Package className="size-10 text-muted-foreground opacity-50" />
          <p className="text-sm text-muted-foreground">Asnjë produkt nuk përputhet me filtrat.</p>
          <Button type="button" variant="outline" size="sm" onClick={openManualCreate}>
            Krijo produktin e parë
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
                E mëparshmja
              </Button>
              <span className="text-sm text-muted-foreground tabular-nums">
                Faqja {pagination.page} nga {pagination.totalPages}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= pagination.totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Tjetra
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
            <AlertDialogTitle>Fshi produktin?</AlertDialogTitle>
            <AlertDialogDescription>
              Kjo heq “{deleteTarget?.name}” nga katalogu juaj. Mund ta restauroni nga baza e të dhënave nëse
              nevojitet; aplikacioni fsheh elementet e fshira butësisht.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anulo</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Duke fshirë…' : 'Fshi'}
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
