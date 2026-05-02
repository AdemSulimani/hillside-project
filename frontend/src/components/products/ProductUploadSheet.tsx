import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  uploadProductDocument,
  uploadProductOcrImage,
} from '@/api/productsApi';
import { Button } from '@/components/ui/button';
import { FileUploadToolbar, type FileUploadToolbarHandle } from '@/components/products/FileUploadToolbar';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';

type UploadKind = 'document' | 'image';

interface ProductUploadSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: UploadKind | null;
}

const DOC_ACCEPT =
  'application/pdf,.pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,application/vnd.ms-excel,.xls,text/csv,.csv';
const IMG_ACCEPT = 'image/jpeg,image/png,image/webp,image/svg+xml';

export function ProductUploadSheet({ open, onOpenChange, kind }: ProductUploadSheetProps) {
  const queryClient = useQueryClient();
  const toolbarRef = useRef<FileUploadToolbarHandle>(null);
  const [file, setFile] = useState<File | null>(null);
  const [useAi, setUseAi] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const reset = () => {
    setFile(null);
    setUseAi(false);
    setError('');
    toolbarRef.current?.clear();
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async () => {
    if (!file || !kind) {
      setError('Zgjidhni një skedar për të ngarkuar.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      if (kind === 'document') {
        const { products, count } = await uploadProductDocument(file, useAi);
        toast.success(
          count === 1
            ? 'U importua 1 produkt nga dokumenti'
            : `U importuan ${count} produkte nga dokumenti`,
        );
        if (products.length === 1) {
          toast.message(products[0].name, { description: 'Mund të ndryshoni detajet nga karta e produktit.' });
        }
      } else {
        await uploadProductOcrImage(file, useAi);
        toast.success('Produkti u importua nga imazhi');
      }
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await queryClient.invalidateQueries({ queryKey: ['product-tags'] });
      handleOpenChange(false);
    } catch (err) {
      const msg =
        err instanceof AxiosError && err.response?.data?.message
          ? String(err.response.data.message)
          : 'Ngarkimi dështoi. Kontrolloni llojin e skedarit dhe provoni përsëri.';
      setError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const title =
    kind === 'document' ? 'Bashkëngjit dokument' : kind === 'image' ? 'Bashkëngjit imazh' : 'Ngarko';
  const description =
    kind === 'document'
      ? 'Ngarkoni PDF ose fletëllogaritje. Nxjerrim tekstin dhe krijojmë rreshta produktesh (strukturim opsional me IA).'
      : kind === 'image'
        ? 'Ngarkoni një foto produkti. Kryejmë OCR dhe krijojmë një produkt skicë (pastrim opsional me IA).'
        : '';

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
        <SheetHeader className="border-b px-4 py-4">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{description}</SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {error && (
            <div className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
          )}

          <FileUploadToolbar
            ref={toolbarRef}
            accept={kind === 'image' ? IMG_ACCEPT : DOC_ACCEPT}
            disabled={loading}
            loading={loading}
            file={file}
            onFileChange={setFile}
            hint={
              kind === 'image'
                ? 'JPEG, PNG, WebP ose SVG — maks. 5 MB'
                : 'PDF, Excel (.xlsx, .xls) ose CSV — maks. 10 MB'
            }
          />

          <div className="flex items-center justify-between rounded-lg border px-3 py-3">
            <div className="space-y-0.5">
              <Label className="text-sm font-medium">Përdor IA (OpenAI)</Label>
              <p className="text-xs text-muted-foreground">
                Përmirëson strukturimin kur në server është konfiguruar një çelës API i vlefshëm.
              </p>
            </div>
            <Switch checked={useAi} onCheckedChange={setUseAi} disabled={loading} />
          </div>
        </div>

        <SheetFooter className="border-t bg-muted/30">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={loading}>
            Anulo
          </Button>
          <Button type="button" onClick={handleSubmit} disabled={loading || !file}>
            {loading && <Loader2 className="animate-spin" />}
            {loading ? 'Duke përpunuar…' : 'Importo'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
