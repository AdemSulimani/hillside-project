import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { CheckCircle2, Edit2, Loader2, Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAdminCatalogBlocks,
  patchAdminCatalogBlock,
  postAdminCreateCatalogBlock,
  type CatalogPromptBlock,
} from '@/api/platformAdminApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

function extractErr(e: unknown): string {
  return e instanceof AxiosError && e.response?.data?.message
    ? String(e.response.data.message)
    : 'Request failed';
}

const PLACEHOLDER_TOKENS = [
  '{{LANGUAGE_NAME}}',
  '{{OTHER_LANGUAGE_NAME}}',
  '{{ORDER_CLOSING_EXAMPLE}}',
  '{{ORDER_CLOSING_FALLBACK}}',
  '{{DISCOUNT_OFFER_EXAMPLE}}',
  '{{DISCOUNT_RULE_NO_FURTHER}}',
  '{{DISCOUNT_RULE_NONE_AVAILABLE}}',
  '{{ORDER_CONFIRMATION_CLOSING_RULE}}',
  '{{DELIVERY_ETA_NOTE}}',
  '{{POST_PURCHASE_ESCALATION_RULE}}',
];

type FormState = {
  key: string;
  title: string;
  description: string;
  default_content: string;
  category: 'guidelines' | 'vision';
  sort_order: number;
  is_platform_locked: boolean;
  is_active: boolean;
  sync_to_existing: boolean;
};

const EMPTY_FORM: FormState = {
  key: '',
  title: '',
  description: '',
  default_content: '',
  category: 'guidelines',
  sort_order: 1000,
  is_platform_locked: false,
  is_active: true,
  sync_to_existing: true,
};

function blockFromCatalog(b: CatalogPromptBlock): FormState {
  return {
    key: b.key,
    title: b.title,
    description: b.description ?? '',
    default_content: b.default_content,
    category: b.category as 'guidelines' | 'vision',
    sort_order: b.sort_order,
    is_platform_locked: b.is_platform_locked,
    is_active: b.is_active,
    sync_to_existing: false,
  };
}

export default function AdminAiCatalogPage() {
  const queryClient = useQueryClient();

  const blocksQuery = useQuery({
    queryKey: ['admin', 'ai', 'catalog-blocks'],
    queryFn: fetchAdminCatalogBlocks,
  });

  const blocks = blocksQuery.data ?? [];

  // —— Dialog state ——
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState<CatalogPromptBlock | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  function openCreate() {
    setEditingBlock(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(block: CatalogPromptBlock) {
    setEditingBlock(block);
    setForm(blockFromCatalog(block));
    setDialogOpen(true);
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  // —— Sync result shown inline after create/update ——
  const [lastSyncSummary, setLastSyncSummary] = useState<{
    tenants_updated: number;
    total_blocks_added: number;
  } | null>(null);

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['admin', 'ai', 'catalog-blocks'] });

  const createMutation = useMutation({
    mutationFn: () =>
      postAdminCreateCatalogBlock({
        ...form,
        description: form.description.trim() || null,
      }),
    onSuccess: (d) => {
      invalidate();
      setLastSyncSummary(d.sync);
      setDialogOpen(false);
      toast.success(
        d.sync
          ? `Guideline created and distributed to ${d.sync.tenants_updated} business(es)`
          : 'Platform guideline created',
      );
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!editingBlock) throw new Error('No block selected');
      return patchAdminCatalogBlock(editingBlock.id, {
        title: form.title,
        description: form.description.trim() || null,
        default_content: form.default_content,
        category: form.category,
        sort_order: form.sort_order,
        is_platform_locked: form.is_platform_locked,
        is_active: form.is_active,
        sync_to_existing: form.sync_to_existing,
      });
    },
    onSuccess: (d) => {
      invalidate();
      setLastSyncSummary(d.sync);
      setDialogOpen(false);
      toast.success(
        d.sync
          ? `Guideline updated and distributed to ${d.sync.tenants_updated} business(es)`
          : 'Platform guideline updated',
      );
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      patchAdminCatalogBlock(id, { is_active }),
    onSuccess: () => {
      invalidate();
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const isBusy = createMutation.isPending || updateMutation.isPending;
  const isEditing = editingBlock !== null;

  const keyError =
    form.key && !/^[a-z0-9_.]+$/.test(form.key)
      ? 'Use lowercase letters, numbers, dots, and underscores only'
      : null;

  const canSubmit =
    form.key.trim() &&
    form.title.trim() &&
    form.default_content.trim() &&
    !keyError &&
    !isBusy;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Platform AI guidelines</h1>
          <p className="mt-1 text-sm text-muted-foreground max-w-2xl">
            These are the master guideline blocks for the AI assistant. Every new business
            automatically receives all <span className="font-medium text-foreground">active</span>{' '}
            blocks when they onboard. Use{' '}
            <span className="font-medium text-foreground">Add guideline</span> to create a new one,
            then opt in to push it to existing businesses in the same step.
          </p>
        </div>
        <Button type="button" onClick={openCreate}>
          <Plus className="mr-2 size-4" />
          Add guideline
        </Button>
      </div>

      {lastSyncSummary && lastSyncSummary.total_blocks_added > 0 ? (
        <div className="flex items-start gap-2 rounded-md border border-green-500/30 bg-green-500/5 px-3 py-2.5 text-sm text-green-800 dark:text-green-300">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <p>
            Synced to <span className="font-medium">{lastSyncSummary.tenants_updated}</span>{' '}
            existing business(es) — {lastSyncSummary.total_blocks_added} block(s) distributed.
          </p>
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Catalog ({blocks.length} blocks)</CardTitle>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Platform-locked</span> blocks cannot be
            disabled per-business.{' '}
            <span className="font-medium text-foreground">Inactive</span> blocks are hidden from
            all businesses and will not be seeded to new ones.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {blocksQuery.isLoading ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading catalog…
              </div>
            ) : blocksQuery.isError ? (
              <p className="p-6 text-sm text-destructive">Failed to load catalog.</p>
            ) : (
              <table className="w-full min-w-[780px] text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/40 text-left">
                    <th className="px-4 py-3 font-medium">Key</th>
                    <th className="px-4 py-3 font-medium">Title</th>
                    <th className="px-4 py-3 font-medium">Category</th>
                    <th className="px-4 py-3 font-medium text-right">Sort</th>
                    <th className="px-4 py-3 font-medium">Flags</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium text-right" />
                  </tr>
                </thead>
                <tbody>
                  {blocks.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                        No catalog blocks yet.
                      </td>
                    </tr>
                  ) : (
                    blocks.map((block) => (
                      <tr key={block.id} className="border-b border-border last:border-0">
                        <td className="px-4 py-3">
                          <code className="text-xs text-muted-foreground">{block.key}</code>
                        </td>
                        <td className="px-4 py-3 font-medium">{block.title}</td>
                        <td className="px-4 py-3">
                          <Badge variant="outline" className="capitalize">
                            {block.category}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                          {block.sort_order}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {block.is_platform_locked ? (
                              <Badge variant="secondary" className="text-[10px]">
                                Locked
                              </Badge>
                            ) : null}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <button
                            type="button"
                            title={block.is_active ? 'Click to deactivate' : 'Click to activate'}
                            disabled={toggleActiveMutation.isPending}
                            onClick={() =>
                              toggleActiveMutation.mutate({
                                id: block.id,
                                is_active: !block.is_active,
                              })
                            }
                            className={cn(
                              'rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors',
                              block.is_active
                                ? 'bg-green-100 text-green-800 hover:bg-green-200 dark:bg-green-900/40 dark:text-green-300'
                                : 'bg-muted text-muted-foreground hover:bg-muted/80',
                            )}
                          >
                            {block.is_active ? 'Active' : 'Inactive'}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => openEdit(block)}
                          >
                            <Edit2 className="mr-1.5 size-3.5" />
                            Edit
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* —— Add / Edit dialog —— */}
      <Dialog open={dialogOpen} onOpenChange={(o) => { if (!isBusy) setDialogOpen(o); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{isEditing ? `Edit guideline — ${editingBlock?.key}` : 'Add platform guideline'}</DialogTitle>
            <p className="text-sm text-muted-foreground">
              {isEditing
                ? 'Changes affect the default content for this block. Businesses that have already customised their copy are unaffected unless you explicitly re-sync.'
                : 'This block will be available to all new businesses automatically. Use the option below to push it to existing businesses too.'}
            </p>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            {/* Key (create only) */}
            {!isEditing ? (
              <div className="space-y-1.5">
                <Label htmlFor="cb-key">
                  Key{' '}
                  <span className="text-xs text-muted-foreground font-normal">
                    (lowercase letters, numbers, dots, underscores — e.g.{' '}
                    <code>guidelines.my_rule</code>)
                  </span>
                </Label>
                <Input
                  id="cb-key"
                  value={form.key}
                  onChange={(e) => set('key', e.target.value.toLowerCase())}
                  placeholder="guidelines.my_rule"
                />
                {keyError ? <p className="text-xs text-destructive">{keyError}</p> : null}
              </div>
            ) : null}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="cb-title">Title</Label>
                <Input
                  id="cb-title"
                  value={form.title}
                  onChange={(e) => set('title', e.target.value)}
                  placeholder="Short descriptive title shown in admin tables"
                />
              </div>

              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="cb-desc">
                  Description{' '}
                  <span className="text-xs text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Input
                  id="cb-desc"
                  value={form.description}
                  onChange={(e) => set('description', e.target.value)}
                  placeholder="One-line summary for admin reference"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cb-category">Category</Label>
                <select
                  id="cb-category"
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  value={form.category}
                  onChange={(e) => set('category', e.target.value as 'guidelines' | 'vision')}
                >
                  <option value="guidelines">guidelines</option>
                  <option value="vision">vision</option>
                </select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="cb-sort">Sort order</Label>
                <Input
                  id="cb-sort"
                  type="number"
                  value={form.sort_order}
                  onChange={(e) => set('sort_order', Number(e.target.value))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="cb-content">
                  Content{' '}
                  <span className="text-xs text-muted-foreground font-normal">
                    (injected verbatim into the AI system prompt)
                  </span>
                </Label>
              </div>
              <Textarea
                id="cb-content"
                value={form.default_content}
                onChange={(e) => set('default_content', e.target.value)}
                rows={14}
                className="font-mono text-xs"
                placeholder="Write the guideline text here. Use {{PLACEHOLDER}} tokens to inject dynamic values."
              />
              <div className="rounded-md border border-border bg-muted/30 p-2.5">
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">Available placeholders</p>
                <div className="flex flex-wrap gap-1.5">
                  {PLACEHOLDER_TOKENS.map((t) => (
                    <code
                      key={t}
                      className="cursor-pointer rounded bg-background px-1.5 py-0.5 text-[10px] border border-border hover:bg-primary/5 hover:border-primary/40 transition-colors"
                      title="Click to insert"
                      onClick={() => set('default_content', form.default_content + t)}
                    >
                      {t}
                    </code>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-md border border-border p-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Options</p>

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input accent-primary"
                  checked={form.is_platform_locked}
                  onChange={(e) => set('is_platform_locked', e.target.checked)}
                />
                <div>
                  <p className="text-sm font-medium">Platform-locked</p>
                  <p className="text-xs text-muted-foreground">
                    Admins cannot disable this block per-business. Use for critical rules the AI must always follow.
                  </p>
                </div>
              </label>

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input accent-primary"
                  checked={form.is_active}
                  onChange={(e) => set('is_active', e.target.checked)}
                />
                <div>
                  <p className="text-sm font-medium">Active</p>
                  <p className="text-xs text-muted-foreground">
                    Inactive blocks are not seeded to new businesses and not shown per-business.
                  </p>
                </div>
              </label>

              <label className="flex cursor-pointer items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input accent-primary"
                  checked={form.sync_to_existing}
                  onChange={(e) => set('sync_to_existing', e.target.checked)}
                  disabled={!form.is_active}
                />
                <div>
                  <p className={cn('text-sm font-medium', !form.is_active && 'text-muted-foreground')}>
                    <RefreshCw className="mr-1 inline-block size-3.5 align-text-bottom" />
                    Apply to all existing businesses now
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Pushes this block to every business that doesn't already have it.
                    Customised copies are never overwritten.
                    {!form.is_active ? ' (Only available when block is active.)' : ''}
                  </p>
                </div>
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={isBusy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canSubmit}
              onClick={() => (isEditing ? updateMutation.mutate() : createMutation.mutate())}
            >
              {isBusy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {isEditing ? 'Save changes' : 'Create guideline'}
              {form.sync_to_existing && form.is_active ? ' & sync' : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
