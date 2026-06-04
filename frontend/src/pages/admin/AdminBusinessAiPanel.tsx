import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  deleteAdminTenantPromptBlockCustom,
  fetchAdminAiVersions,
  fetchAdminTenantAiConfig,
  fetchAdminTenantPromptBlocks,
  patchAdminTenantPromptBlock,
  postAdminRestoreAiVersion,
  postAdminSyncTenantCatalogBlocks,
  postAdminTenantAiTest,
  postAdminTenantPromptBlockCustom,
  postAdminTenantPromptBlockReset,
  putAdminTenantAiConfig,
  type AdminTenantPromptBlockRow,
} from '@/api/platformAdminApi';
import { CheckCircle2, RefreshCw } from 'lucide-react';
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
  if (!(e instanceof AxiosError) || !e.response?.data) return 'Request failed';
  const data = e.response.data as {
    message?: string;
    error?: { body?: Record<string, string[] | { [key: string]: string[] }[]> };
  };
  const bodyErrors = data.error?.body;
  if (bodyErrors) {
    const parts: string[] = [];
    for (const [field, messages] of Object.entries(bodyErrors)) {
      if (Array.isArray(messages)) {
        if (typeof messages[0] === 'string') {
          parts.push(`${field}: ${(messages as string[]).join(', ')}`);
        } else {
          for (const [idx, nested] of (messages as { [key: string]: string[] }[]).entries()) {
            for (const [key, msgs] of Object.entries(nested)) {
              parts.push(`${field}[${idx}].${key}: ${msgs.join(', ')}`);
            }
          }
        }
      }
    }
    if (parts.length > 0) return parts.join(' · ');
  }
  return data.message ? String(data.message) : 'Request failed';
}

const tableClass = 'w-full min-w-[720px] text-sm';
const thClass = 'border-b border-border bg-muted/40 px-3 py-2 text-left font-medium';
const tdClass = 'border-b border-border px-3 py-2 align-top';

export default function AdminBusinessAiPanel({ tenantId }: { tenantId: string }) {
  const queryClient = useQueryClient();

  const configQuery = useQuery({
    queryKey: ['admin', 'tenant', tenantId, 'ai-config'],
    queryFn: () => fetchAdminTenantAiConfig(tenantId),
    enabled: Boolean(tenantId),
  });

  const blocksQuery = useQuery({
    queryKey: ['admin', 'tenant', tenantId, 'ai-prompt-blocks'],
    queryFn: () => fetchAdminTenantPromptBlocks(tenantId),
    enabled: Boolean(tenantId),
  });

  const versionsQuery = useQuery({
    queryKey: ['admin', 'tenant', tenantId, 'ai-versions'],
    queryFn: () => fetchAdminAiVersions(tenantId),
    enabled: Boolean(tenantId),
  });

  const cfg = configQuery.data;
  const [tone, setTone] = useState('');
  const [personality, setPersonality] = useState('');
  const [strategy, setStrategy] = useState('');
  const [objections, setObjections] = useState('');
  const [restrictLines, setRestrictLines] = useState('');
  const [platformLines, setPlatformLines] = useState('');
  const [qaJson, setQaJson] = useState('[]');
  const [active, setActive] = useState(true);
  const [modelId, setModelId] = useState('');

  useEffect(() => {
    if (!cfg) return;
    setTone(cfg.tone);
    setPersonality(cfg.personality_description ?? '');
    setStrategy(cfg.sales_strategy ?? '');
    setObjections(cfg.objection_handling ?? '');
    setRestrictLines((cfg.restrictions ?? []).join('\n'));
    setPlatformLines((cfg.platform_restrictions ?? []).join('\n'));
    setQaJson(JSON.stringify(cfg.qa_pairs ?? [], null, 2));
    setActive(cfg.is_active);
    setModelId(cfg.custom_model_id ?? '');
  }, [cfg]);

  const saveAiMutation = useMutation({
    mutationFn: async () => {
      let qa: { question: string; answer: string }[];
      try {
        qa = JSON.parse(qaJson) as { question: string; answer: string }[];
        if (!Array.isArray(qa)) throw new Error('Q&A JSON must be an array');
      } catch {
        throw new Error('Invalid Q&A JSON');
      }

      await putAdminTenantAiConfig(tenantId, {
        tone,
        personality_description: personality.trim() ? personality : null,
        sales_strategy: strategy.trim() ? strategy : null,
        objection_handling: objections.trim() ? objections : null,
        restrictions: restrictLines.split('\n').map((s) => s.trim()).filter(Boolean),
        platform_restrictions: platformLines.split('\n').map((s) => s.trim()).filter(Boolean),
        qa_pairs: qa,
        is_active: active,
        custom_model_id: modelId.trim() ? modelId.trim() : null,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
      toast.success('AI settings saved (version recorded)');
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const [editRow, setEditRow] = useState<AdminTenantPromptBlockRow | null>(null);
  const [editContent, setEditContent] = useState('');

  const patchBlockMutation = useMutation({
    mutationFn: ({
      id,
      body,
    }: {
      id: string;
      body: { enabled?: boolean; content?: string; sort_order?: number };
    }) => patchAdminTenantPromptBlock(tenantId, id, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const resetBlockMutation = useMutation({
    mutationFn: (id: string) => postAdminTenantPromptBlockReset(tenantId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
      toast.success('Block reset to platform default');
      setEditRow(null);
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const deleteCustomMutation = useMutation({
    mutationFn: (id: string) => deleteAdminTenantPromptBlockCustom(tenantId, id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
      toast.success('Custom block deleted');
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const [customOpen, setCustomOpen] = useState(false);
  const [customKey, setCustomKey] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [customContent, setCustomContent] = useState('');
  const [customOrder, setCustomOrder] = useState(5000);

  const addCustomMutation = useMutation({
    mutationFn: () =>
      postAdminTenantPromptBlockCustom(tenantId, {
        block_key: customKey,
        title: customTitle,
        content: customContent,
        sort_order: customOrder,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
      toast.success('Custom prompt block added');
      setCustomOpen(false);
      setCustomKey('');
      setCustomTitle('');
      setCustomContent('');
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const restoreMutation = useMutation({
    mutationFn: (vid: string) => postAdminRestoreAiVersion(tenantId, vid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
      toast.success('Restored snapshot');
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const [syncResult, setSyncResult] = useState<{ added_count: number; added_block_keys: string[] } | null>(null);

  const syncMutation = useMutation({
    mutationFn: () => postAdminSyncTenantCatalogBlocks(tenantId),
    onSuccess: (d) => {
      setSyncResult(d);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'tenant', tenantId] });
      if (d.added_count > 0) {
        toast.success(`${d.added_count} new platform guideline(s) added`);
      } else {
        toast.success('Already up to date — no new guidelines found');
      }
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const [testMessage, setTestMessage] = useState('What whey protein do you recommend?');
  const [testLang, setTestLang] = useState<'sq' | 'en'>('sq');
  const [testVision, setTestVision] = useState(false);
  const [testReply, setTestReply] = useState<string | null>(null);

  const testMutation = useMutation({
    mutationFn: () =>
      postAdminTenantAiTest(tenantId, {
        testMessage,
        language: testLang,
        include_vision_block: testVision,
      }),
    onSuccess: (d) => {
      setTestReply(d.reply);
      toast.success(`Reply generated (${d.model_used})`);
    },
    onError: (e: unknown) => toast.error(extractErr(e)),
  });

  const sortedBlocks = useMemo(
    () => [...(blocksQuery.data ?? [])].sort((a, b) => a.sort_order - b.sort_order || a.block_key.localeCompare(b.block_key)),
    [blocksQuery.data],
  );

  const busy = saveAiMutation.isPending;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Assistant settings & restrictions</CardTitle>
          <p className="text-sm text-muted-foreground">
            Tone, strategy, objections, operator business rules and platform-wide policies apply after assembled
            prompt blocks — same ordering as production. CRM users do not see or edit these.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {configQuery.isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : configQuery.isError || !cfg ? (
            <p className="text-destructive">Could not load AI configuration.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex items-center gap-2">
                  <input
                    id="ai-active"
                    type="checkbox"
                    className="size-4 rounded border-input accent-primary"
                    checked={active}
                    onChange={(e) => setActive(e.target.checked)}
                  />
                  <Label htmlFor="ai-active">AI assistant enabled</Label>
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label>Tone</Label>
                  <Input value={tone} onChange={(e) => setTone(e.target.value)} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Personality</Label>
                  <Textarea value={personality} onChange={(e) => setPersonality(e.target.value)} rows={2} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Sales strategy</Label>
                  <Textarea value={strategy} onChange={(e) => setStrategy(e.target.value)} rows={2} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Objection handling</Label>
                  <Textarea value={objections} onChange={(e) => setObjections(e.target.value)} rows={2} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>OpenAI model override (optional)</Label>
                  <Input
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    placeholder="ENV default if empty"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Business rules — one bullet per line (operator-managed)</Label>
                  <Textarea value={restrictLines} onChange={(e) => setRestrictLines(e.target.value)} rows={5} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Platform policy bullets — one per line</Label>
                  <Textarea value={platformLines} onChange={(e) => setPlatformLines(e.target.value)} rows={3} />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label>Q&A pairs JSON array</Label>
                  <Textarea value={qaJson} onChange={(e) => setQaJson(e.target.value)} rows={6} className="font-mono text-xs" />
                </div>
              </div>
              <Button type="button" disabled={busy} onClick={() => saveAiMutation.mutate()}>
                {saveAiMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
                Save AI settings
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 pb-2">
          <div>
            <CardTitle className="text-base">Prompt blocks</CardTitle>
            <p className="text-sm text-muted-foreground">
              Edit or disable guideline sections for this tenant only; reset pulls the latest platform template for
              catalog-linked blocks.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setCustomOpen(true)}>
            Add custom block
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            {blocksQuery.isLoading ? (
              <div className="p-6">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <table className={cn(tableClass, 'caption-bottom')}>
                <thead>
                  <tr>
                    <th className={thClass}>Key</th>
                    <th className={thClass}>Title</th>
                    <th className={thClass}>Sort</th>
                    <th className={thClass}>On</th>
                    <th className={thClass} />
                  </tr>
                </thead>
                <tbody>
                  {sortedBlocks.map((row) => (
                    <tr key={row.id}>
                      <td className={tdClass}>
                        <code className="text-xs">{row.block_key}</code>
                        {row.is_platform_locked ? (
                          <Badge variant="outline" className="ml-2 align-middle text-[10px]">
                            Locked
                          </Badge>
                        ) : null}
                      </td>
                      <td className={tdClass}>{row.catalog_title ?? 'Custom'}</td>
                      <td className={tdClass}>
                        <Input
                          className="h-8 w-20 font-mono text-xs"
                          type="number"
                          defaultValue={row.sort_order}
                          onBlur={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (Number.isFinite(n) && n !== row.sort_order) {
                              patchBlockMutation.mutate({ id: row.id, body: { sort_order: n } });
                            }
                          }}
                        />
                      </td>
                      <td className={tdClass}>
                        <input
                          type="checkbox"
                          className="size-4 rounded border-input accent-primary"
                          checked={row.enabled}
                          onChange={(e) => {
                            patchBlockMutation.mutate({
                              id: row.id,
                              body: { enabled: e.target.checked },
                            });
                          }}
                        />
                      </td>
                      <td className={tdClass}>
                        <div className="flex flex-wrap gap-1">
                          <Button type="button" variant="outline" size="sm" onClick={() => {
                            setEditRow(row);
                            setEditContent(row.content);
                          }}>
                            Edit body
                          </Button>
                          {row.prompt_block_id ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="gap-1 px-2"
                              onClick={() => resetBlockMutation.mutate(row.id)}
                              disabled={resetBlockMutation.isPending}
                            >
                              <RotateCcw className="size-3.5" />
                              Reset
                            </Button>
                          ) : (
                            <Button
                              type="button"
                              variant="destructive"
                              size="sm"
                              onClick={() => {
                                if (confirm(`Delete custom block "${row.block_key}"?`)) {
                                  deleteCustomMutation.mutate(row.id);
                                }
                              }}
                            >
                              Delete
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Sync platform guidelines</CardTitle>
          <p className="text-sm text-muted-foreground">
            If new AI guidelines have been added to the platform catalog after this business was
            onboarded, use this to push only the missing ones. Existing guidelines — including any
            customised content — are never overwritten.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => { setSyncResult(null); syncMutation.mutate(); }}
            disabled={syncMutation.isPending}
          >
            {syncMutation.isPending
              ? <Loader2 className="mr-2 size-4 animate-spin" />
              : <RefreshCw className="mr-2 size-4" />}
            Sync missing platform guidelines
          </Button>

          {syncResult !== null ? (
            <div className={cn(
              'flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
              syncResult.added_count > 0
                ? 'border-green-500/30 bg-green-500/5 text-green-800 dark:text-green-300'
                : 'border-border bg-muted/30 text-muted-foreground',
            )}>
              <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              <div>
                {syncResult.added_count > 0 ? (
                  <>
                    <p className="font-medium">{syncResult.added_count} new guideline(s) added</p>
                    <p className="text-xs mt-0.5 font-mono">{syncResult.added_block_keys.join(', ')}</p>
                  </>
                ) : (
                  <p>Already up to date — no new guidelines were found.</p>
                )}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Admin test chat</CardTitle>
          <p className="text-sm text-muted-foreground">
            Uses the same prompt assembly pipeline as inbound replies — optional vision block toggle when testing
            image flows without uploads.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label>Language</Label>
              <select
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
                value={testLang}
                onChange={(e) => setTestLang(e.target.value as 'sq' | 'en')}
              >
                <option value="sq">Albanian (sq)</option>
                <option value="en">English (en)</option>
              </select>
            </div>
            <div className="flex items-center gap-2 pb-2">
              <input
                id="vis"
                type="checkbox"
                className="size-4 rounded border-input accent-primary"
                checked={testVision}
                onChange={(e) => setTestVision(e.target.checked)}
              />
              <Label htmlFor="vis">Include vision-guideline block</Label>
            </div>
          </div>
          <Textarea value={testMessage} onChange={(e) => setTestMessage(e.target.value)} rows={3} />
          <Button type="button" onClick={() => testMutation.mutate()} disabled={testMutation.isPending}>
            {testMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Generate test reply
          </Button>
          {testReply ? (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm whitespace-pre-wrap">{testReply}</div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Snapshots (automatic on each admin save)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {versionsQuery.isLoading ? (
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          ) : (
            <ul className="space-y-2 text-sm">
              {(versionsQuery.data ?? []).slice(0, 15).map((v) => (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2">
                  <span className="text-muted-foreground">
                    {new Date(v.created_at).toLocaleString()}
                    {v.created_by_email ? ` · ${v.created_by_email}` : ''}
                    {v.note ? ` · ${v.note}` : ''}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirm('Restore this snapshot for this tenant? Current settings will update.')) {
                        restoreMutation.mutate(v.id);
                      }
                    }}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(editRow)} onOpenChange={(o) => !o && setEditRow(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit prompt block</DialogTitle>
            <p className="font-mono text-xs text-muted-foreground">{editRow?.block_key}</p>
          </DialogHeader>
          <Textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={18} className="font-mono text-xs" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setEditRow(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (editRow) {
                  patchBlockMutation.mutate(
                    { id: editRow.id, body: { content: editContent } },
                    {
                      onSuccess: () => {
                        toast.success('Block body saved');
                        setEditRow(null);
                      },
                    },
                  );
                }
              }}
            >
              Save block
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New custom guideline block</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="space-y-2">
              <Label>Slug key (letters, numbers, underscore)</Label>
              <Input value={customKey} onChange={(e) => setCustomKey(e.target.value)} placeholder="e.g. holiday_promo_note" />
            </div>
            <div className="space-y-2">
              <Label>Short title</Label>
              <Input value={customTitle} onChange={(e) => setCustomTitle(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Sort order</Label>
              <Input type="number" value={customOrder} onChange={(e) => setCustomOrder(Number(e.target.value))} />
            </div>
            <div className="space-y-2">
              <Label>Content</Label>
              <Textarea value={customContent} onChange={(e) => setCustomContent(e.target.value)} rows={10} />
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              onClick={() => addCustomMutation.mutate()}
              disabled={
                addCustomMutation.isPending ||
                !customKey.trim() ||
                !customTitle.trim() ||
                !customContent.trim()
              }
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
