import { useCallback, useEffect, useState, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { ImagePlus, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  createProduct,
  updateProduct,
  uploadProductImages,
} from '@/api/productsApi';
import { assetUrl, cn } from '@/lib/utils';
import type { Product } from '@/types/product';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  productFormValuesSchema,
  valuesToApiBody,
  type ProductFormValues,
} from '@/components/products/productFormSchema';

const emptyValues = (): ProductFormValues => ({
  name: '',
  priceInput: '',
  description: '',
  sku: '',
  category: '',
  tagsInput: '',
  stockInput: '',
  is_active: true,
});

function productToValues(p: Product): ProductFormValues {
  return {
    name: p.name,
    priceInput: Number.isFinite(p.price) ? String(p.price) : '0',
    description: p.description ?? '',
    sku: p.sku ?? '',
    category: p.category ?? '',
    tagsInput: p.tags.join(', '),
    stockInput: p.stock_quantity != null ? String(p.stock_quantity) : '',
    is_active: p.is_active,
  };
}

interface ProductFormDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: 'create' | 'edit';
  product: Product | null;
}

function flattenZodErrors(err: { flatten: () => { fieldErrors: Record<string, string[] | undefined> } }) {
  const fe = err.flatten().fieldErrors;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fe)) {
    if (v?.[0]) out[k] = v[0];
  }
  return out;
}

function extractServerFieldErrors(err: unknown): Record<string, string> | null {
  if (err instanceof AxiosError && err.response?.data) {
    const data = err.response.data as { error?: { body?: Record<string, string[]> } };
    const body = data.error?.body;
    if (body && typeof body === 'object') {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v) && v[0]) out[k] = v[0];
      }
      return Object.keys(out).length ? out : null;
    }
  }
  return null;
}

const MAX_NEW_IMAGES = 8;
const UPLOAD_CHUNK = 5;

export function ProductFormDrawer({ open, onOpenChange, mode, product }: ProductFormDrawerProps) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<ProductFormValues>(emptyValues);
  const [existingUrls, setExistingUrls] = useState<string[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFieldErrors({});
    setGeneralError('');
    setPendingFiles([]);
    if (mode === 'edit' && product) {
      setValues(productToValues(product));
      setExistingUrls([...product.image_urls]);
    } else {
      setValues(emptyValues());
      setExistingUrls([]);
    }
  }, [open, mode, product?.id]);

  const setField = useCallback(<K extends keyof ProductFormValues>(key: K, v: ProductFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: v }));
    setFieldErrors((e) => {
      if (!e[key as string]) return e;
      const next = { ...e };
      delete next[key as string];
      return next;
    });
  }, []);

  const onPickImages = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      const next = [...pendingFiles];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (!f.type.startsWith('image/')) {
          toast.error(`${f.name} is not an image`);
          continue;
        }
        if (f.size > 5 * 1024 * 1024) {
          toast.error(`${f.name} must be under 5 MB`);
          continue;
        }
        if (next.length >= MAX_NEW_IMAGES) {
          toast.error(`You can add at most ${MAX_NEW_IMAGES} new images at once`);
          break;
        }
        next.push(f);
      }
      setPendingFiles(next);
    },
    [pendingFiles],
  );

  const removePending = (idx: number) => {
    setPendingFiles((p) => p.filter((_, i) => i !== idx));
  };

  const removeExisting = (url: string) => {
    setExistingUrls((u) => u.filter((x) => x !== url));
  };

  const handleSubmit = async () => {
    setGeneralError('');
    const parsed = productFormValuesSchema.safeParse(values);
    if (!parsed.success) {
      setFieldErrors(flattenZodErrors(parsed.error));
      return;
    }

    let body;
    try {
      body = valuesToApiBody(parsed.data);
    } catch (e) {
      setFieldErrors({ stockInput: (e as Error).message });
      return;
    }

    setSaving(true);
    try {
      if (mode === 'create') {
        const created = await createProduct(body);
        let id = created.id;
        for (let i = 0; i < pendingFiles.length; i += UPLOAD_CHUNK) {
          await uploadProductImages(id, pendingFiles.slice(i, i + UPLOAD_CHUNK));
        }
        toast.success('Product created');
      } else if (product) {
        await updateProduct(product.id, { ...body, image_urls: existingUrls });
        for (let i = 0; i < pendingFiles.length; i += UPLOAD_CHUNK) {
          await uploadProductImages(product.id, pendingFiles.slice(i, i + UPLOAD_CHUNK));
        }
        toast.success('Product updated');
      }
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await queryClient.invalidateQueries({ queryKey: ['product-tags'] });
      onOpenChange(false);
    } catch (err) {
      const server = extractServerFieldErrors(err);
      if (server) {
        setFieldErrors(server);
      } else if (err instanceof AxiosError && err.response?.data?.message) {
        setGeneralError(String(err.response.data.message));
      } else {
        setGeneralError('Something went wrong. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-4">
          <SheetTitle>{mode === 'create' ? 'New product' : 'Edit product'}</SheetTitle>
          <SheetDescription>
            {mode === 'create'
              ? 'Add details for a product in your catalog.'
              : 'Update product details and images.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {generalError && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {generalError}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="pf-name">Name</Label>
            <Input
              id="pf-name"
              value={values.name}
              onChange={(e) => setField('name', e.target.value)}
              aria-invalid={!!fieldErrors.name}
              className="h-10"
            />
            {fieldErrors.name && (
              <p className="text-xs text-destructive">{fieldErrors.name}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="pf-price">Price</Label>
              <Input
                id="pf-price"
                inputMode="decimal"
                value={values.priceInput}
                onChange={(e) => setField('priceInput', e.target.value)}
                aria-invalid={!!fieldErrors.priceInput}
                className="h-10"
              />
              {fieldErrors.priceInput && (
                <p className="text-xs text-destructive">{fieldErrors.priceInput}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="pf-stock">Stock quantity</Label>
              <Input
                id="pf-stock"
                inputMode="numeric"
                placeholder="Optional"
                value={values.stockInput}
                onChange={(e) => setField('stockInput', e.target.value)}
                aria-invalid={!!fieldErrors.stockInput}
                className="h-10"
              />
              {fieldErrors.stockInput && (
                <p className="text-xs text-destructive">{fieldErrors.stockInput}</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="pf-sku">SKU</Label>
              <Input
                id="pf-sku"
                value={values.sku}
                onChange={(e) => setField('sku', e.target.value)}
                aria-invalid={!!fieldErrors.sku}
                className="h-10"
              />
              {fieldErrors.sku && (
                <p className="text-xs text-destructive">{fieldErrors.sku}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="pf-category">Category</Label>
              <Input
                id="pf-category"
                value={values.category}
                onChange={(e) => setField('category', e.target.value)}
                aria-invalid={!!fieldErrors.category}
                className="h-10"
              />
              {fieldErrors.category && (
                <p className="text-xs text-destructive">{fieldErrors.category}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-desc">Description</Label>
            <Textarea
              id="pf-desc"
              rows={4}
              value={values.description}
              onChange={(e) => setField('description', e.target.value)}
              aria-invalid={!!fieldErrors.description}
              className="min-h-[100px] resize-none"
            />
            {fieldErrors.description && (
              <p className="text-xs text-destructive">{fieldErrors.description}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-tags">Tags</Label>
            <Input
              id="pf-tags"
              placeholder="Comma-separated"
              value={values.tagsInput}
              onChange={(e) => setField('tagsInput', e.target.value)}
              className="h-10"
            />
            {fieldErrors.tags && (
              <p className="text-xs text-destructive">{fieldErrors.tags}</p>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg border px-3 py-2">
            <div>
              <p className="text-sm font-medium">Active</p>
              <p className="text-xs text-muted-foreground">Visible in your catalog</p>
            </div>
            <Switch
              checked={values.is_active}
              onCheckedChange={(v) => setField('is_active', Boolean(v))}
            />
          </div>

          <div className="space-y-2">
            <Label>Images</Label>
            <p className="text-xs text-muted-foreground">
              Existing images can be removed. New images upload after you save.
            </p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {existingUrls.map((url) => {
                const src = assetUrl(url);
                return (
                  <div key={url} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
                    {src ? (
                      <img src={src} alt="" className="size-full object-cover" />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeExisting(url)}
                      className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="Remove image"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                );
              })}
              {pendingFiles.map((f, i) => (
                <div
                  key={`${f.name}-${i}`}
                  className="group relative aspect-square overflow-hidden rounded-md border bg-muted"
                >
                  <img src={URL.createObjectURL(f)} alt="" className="size-full object-cover" />
                  <button
                    type="button"
                    onClick={() => removePending(i)}
                    className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Remove pending image"
                  >
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>

            <label
              className={cn(
                'flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-xs transition-colors hover:bg-muted/40',
                saving && 'pointer-events-none opacity-50',
              )}
              onDragOver={(e: DragEvent) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDrop={(e: DragEvent) => {
                e.preventDefault();
                if (saving) return;
                onPickImages(e.dataTransfer.files);
              }}
            >
              <ImagePlus className="size-6 text-muted-foreground" />
              <span>Drop images or click to add (max {MAX_NEW_IMAGES} new)</span>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/svg+xml"
                multiple
                className="hidden"
                disabled={saving}
                onChange={(e) => {
                  onPickImages(e.target.files);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
        </div>

        <SheetFooter className="border-t bg-muted/30">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
