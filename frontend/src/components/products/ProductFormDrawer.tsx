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
  brand: '',
  priceInput: '',
  discountedPriceInput: '',
  description: '',
  usage_description: '',
  sku: '',
  category: '',
  flavor: '',
  size: '',
  color: '',
  variant: '',
  weight: '',
  tagsInput: '',
  in_stock: true,
  is_active: true,
});

function productToValues(p: Product): ProductFormValues {
  return {
    name: p.name,
    brand: p.brand ?? '',
    priceInput: Number.isFinite(p.price) ? String(p.price) : '0',
    discountedPriceInput:
      p.discounted_price != null && Number.isFinite(p.discounted_price)
        ? String(p.discounted_price)
        : '',
    description: p.description ?? '',
    usage_description: p.usage_description ?? '',
    sku: p.sku ?? '',
    category: p.category ?? '',
    flavor: p.flavor ?? '',
    size: p.size ?? '',
    color: p.color ?? '',
    variant: p.variant ?? '',
    weight: p.weight ?? '',
    tagsInput: p.tags.join(', '),
    in_stock: p.in_stock !== false,
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
  if (!(err instanceof AxiosError) || !err.response?.data) return null;

  const data = err.response.data as {
    error?: { body?: Record<string, string[]> };
    message?: string;
  };

  const out: Record<string, string> = {};
  const body = data.error?.body;
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body)) {
      if (Array.isArray(v) && v[0]) {
        if (k === 'discounted_price') out.discountedPriceInput = v[0];
        else out[k] = v[0];
      }
    }
  }

  if (Object.keys(out).length > 0) return out;

  const message = data.message?.trim();
  if (!message) return null;

  if (message.toLowerCase().includes('name already exists')) {
    return { name: 'Një produkt me këtë emër ekziston tashmë në katalog.' };
  }
  if (message.toLowerCase().includes('discounted price')) {
    return { discountedPriceInput: 'Çmimi i zbritur duhet të jetë më i ulët se çmimi i rregullt.' };
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
  }, [open, mode, product]);

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
          toast.error(`${f.name} nuk është imazh`);
          continue;
        }
        if (f.size > 5 * 1024 * 1024) {
          toast.error(`${f.name} duhet të jetë nën 5 MB`);
          continue;
        }
        if (next.length >= MAX_NEW_IMAGES) {
          toast.error(`Mund të shtoni së shumti ${MAX_NEW_IMAGES} imazhe të reja njëherësh`);
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
      setGeneralError((e as Error).message);
      return;
    }

    setSaving(true);
    try {
      if (mode === 'create') {
        const created = await createProduct(body);
        const id = created.id;
        for (let i = 0; i < pendingFiles.length; i += UPLOAD_CHUNK) {
          await uploadProductImages(id, pendingFiles.slice(i, i + UPLOAD_CHUNK));
        }
        toast.success('Produkti u krijua');
      } else if (product) {
        await updateProduct(product.id, { ...body, image_urls: existingUrls });
        for (let i = 0; i < pendingFiles.length; i += UPLOAD_CHUNK) {
          await uploadProductImages(product.id, pendingFiles.slice(i, i + UPLOAD_CHUNK));
        }
        toast.success('Produkti u përditësua');
      }
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await queryClient.invalidateQueries({ queryKey: ['product-tags'] });
      onOpenChange(false);
    } catch (err) {
      const server = extractServerFieldErrors(err);
      if (server) {
        setFieldErrors(server);
      } else if (err instanceof AxiosError && err.response?.status === 409) {
        setFieldErrors({ name: 'Një produkt me këtë emër ekziston tashmë në katalog.' });
      } else if (err instanceof AxiosError && err.response?.data?.message) {
        setGeneralError(String(err.response.data.message));
      } else {
        setGeneralError('Diçka shkoi keq. Ju lutemi provoni përsëri.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-4">
          <SheetTitle>{mode === 'create' ? 'Produkt i ri' : 'Ndrysho produktin'}</SheetTitle>
          <SheetDescription>
            {mode === 'create'
              ? 'Shto detajet për një produkt në katalogun tënd.'
              : 'Përditëso detajet dhe imazhet e produktit.'}
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {generalError && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {generalError}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="pf-name">Emri</Label>
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

          <div className="space-y-2">
            <Label htmlFor="pf-brand">Marka</Label>
            <Input
              id="pf-brand"
              placeholder="Opsionale"
              value={values.brand}
              onChange={(e) => setField('brand', e.target.value)}
              aria-invalid={!!fieldErrors.brand}
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">
              Shtimi i markës ndihmon IA-në të identifikojë dhe përputhë produktet kur klientët dërgojnë foto produktesh.
            </p>
            {fieldErrors.brand && (
              <p className="text-xs text-destructive">{fieldErrors.brand}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="pf-price">Çmimi</Label>
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
              <Label htmlFor="pf-stock">Gjendja e stokut</Label>
              <select
                id="pf-stock"
                className={cn(
                  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
                )}
                value={values.in_stock ? 'in' : 'out'}
                onChange={(e) => setField('in_stock', e.target.value === 'in')}
                aria-invalid={!!fieldErrors.in_stock}
              >
                <option value="in">Në stok</option>
                <option value="out">Jashtë stokut</option>
              </select>
              {fieldErrors.in_stock && (
                <p className="text-xs text-destructive">{fieldErrors.in_stock}</p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-discounted-price">
              Çmimi i zbritur{' '}
              <span className="font-normal text-muted-foreground">(opsional)</span>
            </Label>
            <Input
              id="pf-discounted-price"
              inputMode="decimal"
              placeholder="Lëreni bosh nëse nuk ka zbritje"
              value={values.discountedPriceInput}
              onChange={(e) => setField('discountedPriceInput', e.target.value)}
              aria-invalid={!!fieldErrors.discountedPriceInput}
              className="h-10"
            />
            <p className="text-xs text-muted-foreground">
              Zbritja maksimale që IA-ja mund të ofrojë kur klienti kërkon çmim më të ulët. Duhet të jetë më e ulët se çmimi i rregullt. Lëreni bosh nëse nuk ka zbritje — IA-ja do të thotë se çmimi aktual është final.
            </p>
            {fieldErrors.discountedPriceInput && (
              <p className="text-xs text-destructive">{fieldErrors.discountedPriceInput}</p>
            )}
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
              <Label htmlFor="pf-category">Kategoria</Label>
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
            <Label className="text-sm font-medium">Atribute produkti</Label>
            <p className="text-xs text-muted-foreground">
              Ndihmojnë IA-në të përgjigjet saktë për shijet, madhësitë, ngjyrat dhe variante kur klientët pyesin për një kategori produktesh.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="pf-flavor">Shija</Label>
                <Input
                  id="pf-flavor"
                  value={values.flavor}
                  onChange={(e) => setField('flavor', e.target.value)}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pf-size">Madhësia</Label>
                <Input
                  id="pf-size"
                  value={values.size}
                  onChange={(e) => setField('size', e.target.value)}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pf-color">Ngjyra</Label>
                <Input
                  id="pf-color"
                  value={values.color}
                  onChange={(e) => setField('color', e.target.value)}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pf-variant">Varianti</Label>
                <Input
                  id="pf-variant"
                  value={values.variant}
                  onChange={(e) => setField('variant', e.target.value)}
                  className="h-10"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pf-weight">Pesha</Label>
                <Input
                  id="pf-weight"
                  value={values.weight}
                  onChange={(e) => setField('weight', e.target.value)}
                  className="h-10"
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-desc">Përshkrimi</Label>
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
            <Label htmlFor="pf-usage-description">Udhëzime përdorimi</Label>
            <Textarea
              id="pf-usage-description"
              rows={5}
              placeholder="Shpjegoni saktësisht si përdoret produkti — dozimi, metoda, koha, paralajmërimet etj. IA-ja do të kthejë këtë tekst saktësisht siç është shkruar kur klientët pyesin për përdorimin."
              value={values.usage_description}
              onChange={(e) => setField('usage_description', e.target.value)}
              aria-invalid={!!fieldErrors.usage_description}
              className="min-h-[120px] resize-none"
            />
            <p className="text-xs text-muted-foreground">
              Shkruajeni me kujdes — IA-ja do ta kopjojë fjalë për fjalë kur klientët pyesin si përdoret produkti.
            </p>
            {fieldErrors.usage_description && (
              <p className="text-xs text-destructive">{fieldErrors.usage_description}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="pf-tags">Etiketat</Label>
            <Input
              id="pf-tags"
              placeholder="Të ndara me presje"
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
              <p className="text-sm font-medium">Aktiv</p>
              <p className="text-xs text-muted-foreground">I dukshëm në katalogun tuaj</p>
            </div>
            <Switch
              checked={values.is_active}
              onCheckedChange={(v) => setField('is_active', Boolean(v))}
            />
          </div>

          <div className="space-y-2">
            <Label>Imazhet</Label>
            <p className="text-xs text-muted-foreground">
              Imazhet ekzistuese mund të hiqen. Imazhet e reja ngarkohen pasi të ruani.
            </p>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {existingUrls.map((url) => {
                const src = assetUrl(url);
                return (
                  <div key={url} className="group relative aspect-square overflow-hidden rounded-md border bg-muted">
                    {src ? (
                      <img
                        src={src}
                        alt=""
                        className="size-full object-cover"
                        loading="lazy"
                        decoding="async"
                      />
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeExisting(url)}
                      className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
                      aria-label="Hiq imazhin"
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
                  <img
                    src={URL.createObjectURL(f)}
                    alt=""
                    className="size-full object-cover"
                    loading="lazy"
                    decoding="async"
                  />
                  <button
                    type="button"
                    onClick={() => removePending(i)}
                    className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm opacity-0 transition-opacity group-hover:opacity-100"
                    aria-label="Hiq imazhin në pritje"
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
              <span>Hidhni imazhe ose klikoni për të shtuar (maks. {MAX_NEW_IMAGES} të reja)</span>
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
            Anulo
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={saving}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? 'Duke ruajtur…' : mode === 'create' ? 'Krijo' : 'Ruaj'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
