import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { ExternalLink, Globe, Image, Loader2, MessageCircleMore, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';
import {
  cancelOrder,
  confirmOrder,
  fetchOrderById,
  updateDraftOrder,
} from '@/api/ordersApi';
import { buildInferredOrderTimeline } from '@/lib/orderTimeline';
import { formatCurrency } from '@/lib/formatCurrency';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import { cn } from '@/lib/utils';
import { OrderStatusBadge } from '@/components/orders/orderStatusBadge';
import type { ChannelType } from '@/types/conversation';
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
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';

const ORDER_CHANNEL_ICONS: Record<ChannelType, LucideIcon> = {
  facebook: Globe,
  instagram: Image,
  whatsapp: MessageCircleMore,
};

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

const draftFormSchema = z.object({
  quantityInput: z
    .string()
    .min(1, 'E detyrueshme')
    .refine((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) && n >= 1 && n <= 999_999;
    }, 'Vendosni një numër të plotë ≥ 1'),
  delivery_address: z.string().max(8000),
  notes: z.string().max(10000),
});

interface OrderDetailDrawerProps {
  orderId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OrderDetailDrawer({ orderId, open, onOpenChange }: OrderDetailDrawerProps) {
  const queryClient = useQueryClient();
  const [quantityInput, setQuantityInput] = useState('1');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['orders', 'detail', orderId],
    queryFn: () => fetchOrderById(orderId!),
    enabled: open && Boolean(orderId),
  });

  const order = detailQuery.data;

  /* eslint-disable react-hooks/set-state-in-effect -- hydrate draft fields when the loaded order changes */
  useEffect(() => {
    if (!open || !order) return;
    setQuantityInput(String(order.quantity));
    setDeliveryAddress(order.delivery_address ?? '');
    setNotes(order.notes ?? '');
    setFieldErrors({});
  }, [open, order?.id, order?.updated_at, order]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const saveMutation = useMutation({
    mutationFn: async () => {
      const parsed = draftFormSchema.safeParse({
        quantityInput,
        delivery_address: deliveryAddress,
        notes,
      });
      if (!parsed.success) {
        const fe = parsed.error.flatten().fieldErrors;
        const next: Record<string, string> = {};
        if (fe.quantityInput?.[0]) next.quantityInput = fe.quantityInput[0];
        if (fe.delivery_address?.[0]) next.delivery_address = fe.delivery_address[0];
        if (fe.notes?.[0]) next.notes = fe.notes[0];
        setFieldErrors(next);
        throw new Error('Validation failed');
      }
      setFieldErrors({});
      const qty = parseInt(parsed.data.quantityInput, 10);
      return updateDraftOrder(orderId!, {
        quantity: qty,
        delivery_address: parsed.data.delivery_address.trim() || null,
        notes: parsed.data.notes.trim() || null,
      });
    },
    onSuccess: () => {
      toast.success('Porosia u përditësua');
      void queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'draft-for-conversation'] });
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'Validation failed') return;
      toast.error(extractMessage(err, 'Porosia nuk u ruajt'));
    },
  });

  const confirmMutation = useMutation({
    mutationFn: () => confirmOrder(orderId!),
    onSuccess: () => {
      toast.success('Porosia u konfirmua');
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'draft-for-conversation'] });
    },
    onError: (err) => toast.error(extractMessage(err, 'Konfirmimi i porosisë dështoi')),
  });

  const cancelMutation = useMutation({
    mutationFn: () => cancelOrder(orderId!),
    onSuccess: () => {
      toast.success('Porosia u anulua');
      setCancelOpen(false);
      void queryClient.invalidateQueries({ queryKey: ['orders', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'detail', orderId] });
      void queryClient.invalidateQueries({ queryKey: ['orders', 'draft-for-conversation'] });
    },
    onError: (err) => toast.error(extractMessage(err, 'Anulimi i porosisë dështoi')),
  });

  const isDraft = order?.status === 'draft';
  const ChannelIcon = order
    ? (ORDER_CHANNEL_ICONS[order.channel.type] ?? MessageCircleMore)
    : MessageCircleMore;
  const timeline = order
    ? buildInferredOrderTimeline(order.status, order.created_at, order.updated_at)
    : [];

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="right"
          className="flex h-full w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        >
          <SheetHeader className="shrink-0 space-y-1.5 border-b border-border p-0 px-5 pt-5 pb-4 pr-14 text-left sm:px-6">
            <SheetTitle>Detajet e porosisë</SheetTitle>
            <SheetDescription>
              Rishikoni artikujt, dërgesën dhe statusin. Porositë skicë mund të përpunohen këtu.
            </SheetDescription>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5 sm:px-6 sm:py-6">
            {detailQuery.isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
              </div>
            ) : detailQuery.isError || !order ? (
              <p className="text-sm text-destructive">Kjo porosi nuk u ngarkua.</p>
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm text-muted-foreground">Klienti</p>
                    <p className="text-lg font-semibold">{order.customer_name}</p>
                    {order.customer_phone ? (
                      <p className="text-sm text-muted-foreground">{order.customer_phone}</p>
                    ) : null}
                  </div>
                  <OrderStatusBadge status={order.status} />
                </div>

                <div className="flex items-start gap-2.5 text-sm text-muted-foreground">
                  <ChannelIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 leading-snug">
                    <span className="font-medium text-foreground">{order.channel.name}</span>
                    <span className="text-muted-foreground"> · </span>
                    <span className="capitalize">{order.channel.type}</span>
                  </span>
                </div>

                <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground">Produkti</span>
                    <span className="text-right font-medium">{order.product_name}</span>
                  </div>
                  <div className="mt-2 flex justify-between gap-2">
                    <span className="text-muted-foreground">Çmimi për njësi</span>
                    <span className="tabular-nums">{formatCurrency(order.unit_price)}</span>
                  </div>
                  <div className="mt-2 flex justify-between gap-2">
                    <span className="text-muted-foreground">Totali i rreshtit</span>
                    <span className="font-semibold tabular-nums">
                      {formatCurrency(order.total_price)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Zbuluar nga{' '}
                    {order.detected_by === 'ai' ? 'IA' : order.detected_by === 'human' ? 'njeriu' : order.detected_by}
                  </p>
                </div>

                {isDraft ? (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="order-qty">Sasia</Label>
                      <Input
                        id="order-qty"
                        inputMode="numeric"
                        value={quantityInput}
                        onChange={(e) => setQuantityInput(e.target.value)}
                        className={cn(fieldErrors.quantityInput && 'border-destructive')}
                        aria-invalid={Boolean(fieldErrors.quantityInput)}
                      />
                      {fieldErrors.quantityInput ? (
                        <p className="text-xs text-destructive">{fieldErrors.quantityInput}</p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="order-address">Adresa e dërgesës</Label>
                      <Textarea
                        id="order-address"
                        rows={3}
                        value={deliveryAddress}
                        onChange={(e) => setDeliveryAddress(e.target.value)}
                        className={cn(fieldErrors.delivery_address && 'border-destructive')}
                        placeholder="Rruga, qyteti, kodi postar…"
                      />
                      {fieldErrors.delivery_address ? (
                        <p className="text-xs text-destructive">{fieldErrors.delivery_address}</p>
                      ) : null}
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="order-notes">Shënime të brendshme</Label>
                      <Textarea
                        id="order-notes"
                        rows={3}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        className={cn(fieldErrors.notes && 'border-destructive')}
                      />
                      {fieldErrors.notes ? (
                        <p className="text-xs text-destructive">{fieldErrors.notes}</p>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      disabled={saveMutation.isPending}
                      onClick={() => saveMutation.mutate()}
                    >
                      {saveMutation.isPending ? (
                        <>
                          <Loader2 className="size-4 animate-spin" />
                          Duke ruajtur…
                        </>
                      ) : (
                        'Ruaj ndryshimet'
                      )}
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-5 text-sm">
                    <div className="flex justify-between gap-4">
                      <span className="text-muted-foreground">Sasia</span>
                      <span className="tabular-nums font-medium text-foreground">{order.quantity}</span>
                    </div>
                    {order.delivery_address ? (
                      <div className="space-y-1.5">
                        <p className="text-muted-foreground">Adresa e dërgesës</p>
                        <p className="whitespace-pre-wrap text-foreground">{order.delivery_address}</p>
                      </div>
                    ) : null}
                    {order.notes ? (
                      <div className="space-y-1.5">
                        <p className="text-muted-foreground">Shënime</p>
                        <p className="whitespace-pre-wrap text-foreground">{order.notes}</p>
                      </div>
                    ) : null}
                  </div>
                )}

                <Separator />

                <div>
                  <p className="mb-4 text-sm font-medium text-foreground">Kronologjia e statusit</p>
                  <ul className="space-y-0">
                    {timeline.map((entry, index) => (
                      <li key={entry.key} className="flex gap-3 pb-5 last:pb-0">
                        <div className="flex w-5 shrink-0 flex-col items-center pt-1">
                          <span
                            className="size-2.5 shrink-0 rounded-full bg-primary ring-2 ring-primary/20"
                            aria-hidden
                          />
                          {index < timeline.length - 1 ? (
                            <span
                              className="mt-1.5 min-h-[1.25rem] w-px flex-1 bg-border"
                              aria-hidden
                            />
                          ) : null}
                        </div>
                        <div className="min-w-0 flex-1 pt-0.5">
                          <p className="text-sm font-medium leading-snug text-foreground">
                            {entry.label}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {formatRelativeShort(entry.at)}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>

                <Separator />

                <Link
                  to={`/inbox?c=${order.conversation.id}`}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'default' }),
                    'w-full gap-2',
                  )}
                  onClick={() => onOpenChange(false)}
                >
                  <ExternalLink className="size-4" />
                  Hape bisedën
                </Link>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    className="flex-1"
                    disabled={!isDraft || confirmMutation.isPending}
                    onClick={() => setConfirmOpen(true)}
                  >
                    Konfirmo porosinë
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    className="flex-1"
                    disabled={order.status === 'cancelled' || cancelMutation.isPending}
                    onClick={() => setCancelOpen(true)}
                  >
                    Anulo porosinë
                  </Button>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Konfirmoni këtë porosi?</AlertDialogTitle>
            <AlertDialogDescription>
              Klienti do të konsiderohet i angazhuar. Mund ta anuloni më vonë nëse duhet.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Prapa</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => orderId && confirmMutation.mutate()}
              disabled={confirmMutation.isPending}
            >
              {confirmMutation.isPending ? 'Duke konfirmuar…' : 'Konfirmo'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Anuloni këtë porosi?</AlertDialogTitle>
            <AlertDialogDescription>
              Kjo e shënon porosinë si të anuluar. Nuk do të duket më aktive në rrjedhën tuaj të punës.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Prapa</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
              onClick={() => orderId && cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? 'Duke anuluar…' : 'Anulo porosinë'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
