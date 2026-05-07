import { useState, useEffect, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import {
  BrainCircuit,
  Loader2,
  Plus,
  Trash2,
  X,
  Sparkles,
  SendHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { fetchAIConfig, updateAIConfig, testAIConfig as requestAITest } from '@/api/aiConfigApi';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import type { AIConfigTestPayload, AIConfigUpdatePayload, QAPair } from '@/types/aiConfig';

const TONE_OPTIONS = [
  { value: 'professional', label: 'Professional' },
  { value: 'friendly', label: 'Friendly' },
  { value: 'casual', label: 'Casual' },
  { value: 'formal', label: 'Formal' },
  { value: 'enthusiastic', label: 'Enthusiastic' },
] as const;

const selectClasses =
  'h-10 w-full appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

interface QARow extends QAPair {
  localId: string;
}

type BodyFieldErrors = Record<string, string[] | undefined>;

function newQARow(): QARow {
  return { localId: crypto.randomUUID(), question: '', answer: '' };
}

function buildPayloadFromForm(
  tone: string,
  personalityDescription: string,
  restrictions: string[],
  salesStrategy: string,
  objectionHandling: string,
  qaRows: QARow[],
  isActive: boolean,
  customModelId: string | null,
): AIConfigUpdatePayload {
  const qa_pairs: QAPair[] = qaRows
    .map((r) => ({
      question: r.question.trim(),
      answer: r.answer.trim(),
    }))
    .filter((p) => p.question && p.answer);

  return {
    tone,
    personality_description: personalityDescription.trim() || null,
    restrictions: restrictions.map((r) => r.trim()).filter(Boolean),
    sales_strategy: salesStrategy.trim() || null,
    objection_handling: objectionHandling.trim() || null,
    qa_pairs,
    is_active: isActive,
    custom_model_id: customModelId,
  };
}

function validateQARows(qaRows: QARow[]): string | null {
  for (const row of qaRows) {
    const q = row.question.trim();
    const a = row.answer.trim();
    if ((q && !a) || (!q && a)) {
      return 'Each Q&A pair must include both question and answer, or leave both fields empty.';
    }
  }
  return null;
}

function extractFieldErrors(err: unknown): BodyFieldErrors | null {
  if (err instanceof AxiosError && err.response) {
    const { status, data } = err.response;
    if (status === 400 || status === 422) {
      const raw = data?.error;
      if (raw && typeof raw === 'object') {
        const body = (raw as { body?: BodyFieldErrors }).body ?? (raw as BodyFieldErrors);
        if (body && typeof body === 'object') return body;
      }
    }
  }
  return null;
}

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

function formatFieldErrorMessages(errors: BodyFieldErrors): string[] {
  return Object.values(errors)
    .flat()
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
}

export default function AIConfigPage() {
  const queryClient = useQueryClient();

  const [tone, setTone] = useState<string>('professional');
  const [personalityDescription, setPersonalityDescription] = useState('');
  const [restrictionDraft, setRestrictionDraft] = useState('');
  const [restrictions, setRestrictions] = useState<string[]>([]);
  const [salesStrategy, setSalesStrategy] = useState('');
  const [objectionHandling, setObjectionHandling] = useState('');
  const [qaRows, setQaRows] = useState<QARow[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [customModelId, setCustomModelId] = useState<string | null>(null);

  const [testMessage, setTestMessage] = useState('');
  const [testReply, setTestReply] = useState<string | null>(null);

  const [clientError, setClientError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<BodyFieldErrors>({});

  const { data: config, isLoading, isError, error: loadError } = useQuery({
    queryKey: ['ai-config'],
    queryFn: fetchAIConfig,
  });

  /* eslint-disable react-hooks/set-state-in-effect -- mirror server config into controlled form fields */
  useEffect(() => {
    if (!config) return;
    setTone(config.tone || 'professional');
    setPersonalityDescription(config.personality_description ?? '');
    setRestrictions([...config.restrictions]);
    setSalesStrategy(config.sales_strategy ?? '');
    setObjectionHandling(config.objection_handling ?? '');
    setQaRows(
      config.qa_pairs.length > 0
        ? config.qa_pairs.map((p) => ({
            localId: crypto.randomUUID(),
            question: p.question,
            answer: p.answer,
          }))
        : [],
    );
    setIsActive(config.is_active);
    setCustomModelId(config.custom_model_id);
  }, [config]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const saveMutation = useMutation({
    mutationFn: (payload: AIConfigUpdatePayload) => updateAIConfig(payload),
    onSuccess: () => {
      setClientError('');
      setFieldErrors({});
      queryClient.invalidateQueries({ queryKey: ['ai-config'] });
      toast.success('AI configuration saved');
    },
    onError: (err) => {
      const fe = extractFieldErrors(err);
      if (fe) {
        setFieldErrors(fe);
        setClientError('');
      } else {
        setFieldErrors({});
        setClientError(extractMessage(err, 'Saving AI configuration failed'));
      }
    },
  });

  const testMutation = useMutation({
    mutationFn: (payload: AIConfigTestPayload) => requestAITest(payload),
    onSuccess: (reply) => {
      setTestReply(reply);
      toast.success('Test response received');
    },
    onError: (err) => {
      setTestReply(null);
      toast.error(extractMessage(err, 'AI test failed'));
    },
  });

  function addRestriction() {
    const t = restrictionDraft.trim();
    if (!t) return;
    if (restrictions.includes(t)) {
      setRestrictionDraft('');
      return;
    }
    setRestrictions((prev) => [...prev, t]);
    setRestrictionDraft('');
  }

  function removeRestriction(index: number) {
    setRestrictions((prev) => prev.filter((_, i) => i !== index));
  }

  function addQARow() {
    setQaRows((prev) => [...prev, newQARow()]);
  }

  function removeQARow(localId: string) {
    setQaRows((prev) => prev.filter((r) => r.localId !== localId));
  }

  function updateQARow(localId: string, patch: Partial<Pick<QARow, 'question' | 'answer'>>) {
    setQaRows((prev) =>
      prev.map((r) => (r.localId === localId ? { ...r, ...patch } : r)),
    );
  }

  function handleSave(e: FormEvent) {
    e.preventDefault();
    setClientError('');
    setFieldErrors({});

    const qaErr = validateQARows(qaRows);
    if (qaErr) {
      setClientError(qaErr);
      return;
    }

    const payload = buildPayloadFromForm(
      tone,
      personalityDescription,
      restrictions,
      salesStrategy,
      objectionHandling,
      qaRows,
      isActive,
      customModelId,
    );

    if (!payload.tone.trim()) {
      setClientError('Please choose a tone.');
      return;
    }

    saveMutation.mutate(payload);
  }

  function handleSendTest() {
    const msg = testMessage.trim();
    if (!msg) {
      toast.error('Write a test message');
      return;
    }

    const qaErr = validateQARows(qaRows);
    if (qaErr) {
      toast.error(qaErr);
      return;
    }

    const base = buildPayloadFromForm(
      tone,
      personalityDescription,
      restrictions,
      salesStrategy,
      objectionHandling,
      qaRows,
      isActive,
      customModelId,
    );

    testMutation.mutate({ ...base, testMessage: msg });
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-2 h-4 w-80" />
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">AI Configuration</h1>
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {extractMessage(loadError, 'AI configuration could not be loaded.')}
        </div>
      </div>
    );
  }

  const serverFieldMessages = formatFieldErrorMessages(fieldErrors);

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">AI Configuration</h1>
        <p className="text-sm text-muted-foreground">
          Customize how your AI assistant sounds, what it can say, and how it sells.
        </p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        {/* Personality */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-muted-foreground" />
              <CardTitle>Personality</CardTitle>
            </div>
            <CardDescription>Tone and behavior for every reply.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-tone">Tone</Label>
              <select
                id="ai-tone"
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                className={selectClasses}
                aria-invalid={!!fieldErrors.tone}
              >
                {TONE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {fieldErrors.tone?.map((m) => (
                <p key={m} className="text-xs text-destructive">
                  {m}
                </p>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="personality-description">Personality description</Label>
              <Textarea
                id="personality-description"
                value={personalityDescription}
                onChange={(e) => setPersonalityDescription(e.target.value)}
                placeholder="Describe how the assistant should behave (optional)..."
                rows={4}
                aria-invalid={!!fieldErrors.personality_description}
              />
              {fieldErrors.personality_description?.map((m) => (
                <p key={m} className="text-xs text-destructive">
                  {m}
                </p>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Restrictions */}
        <Card>
          <CardHeader>
            <CardTitle>Restrictions</CardTitle>
            <CardDescription>Hard rules the AI must follow.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1 space-y-2">
                <Label htmlFor="restriction-input">Add restriction</Label>
                <Input
                  id="restriction-input"
                  value={restrictionDraft}
                  onChange={(e) => setRestrictionDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addRestriction();
                    }
                  }}
                  placeholder="e.g. Never mention competitor brands"
                  className="h-10"
                />
              </div>
              <Button type="button" variant="secondary" className="shrink-0" onClick={addRestriction}>
                <Plus className="size-4" />
                Add
              </Button>
            </div>
            {restrictions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {restrictions.map((r, i) => (
                  <Badge
                    key={`${r}-${i}`}
                    variant="secondary"
                    className="h-7 max-w-full gap-1 pr-1 pl-2.5 font-normal"
                  >
                    <span className="truncate">{r}</span>
                    <button
                      type="button"
                      onClick={() => removeRestriction(i)}
                      className="ml-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={`Hiq kufizimin: ${r}`}
                    >
                      <X className="size-3.5" />
                    </button>
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No restrictions yet.</p>
            )}
            {fieldErrors.restrictions?.map((m) => (
              <p key={m} className="text-xs text-destructive">
                {m}
              </p>
            ))}
          </CardContent>
        </Card>

        {/* Sales strategy */}
        <Card>
          <CardHeader>
            <CardTitle>Strategjia e shitjes</CardTitle>
            <CardDescription>Si duhet të udhëheqë ndihmësi bisedat.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="sales-strategy">Strategjia</Label>
              <Textarea
                id="sales-strategy"
                value={salesStrategy}
                onChange={(e) => setSalesStrategy(e.target.value)}
                placeholder="Përshkruani qasjen tuaj për ndihmë ndaj klientëve dhe mbylljen e shitjeve…"
                rows={5}
                aria-invalid={!!fieldErrors.sales_strategy}
              />
              {fieldErrors.sales_strategy?.map((m) => (
                <p key={m} className="text-xs text-destructive">
                  {m}
                </p>
              ))}
            </div>
            <div className="space-y-2">
              <Label htmlFor="objection-handling">Trajtimi i kundërshtimeve</Label>
              <Textarea
                id="objection-handling"
                value={objectionHandling}
                onChange={(e) => setObjectionHandling(e.target.value)}
                placeholder="Si duhet të përgjigjet ndihmësi ndaj hezitimeve ose kundërshtimeve…"
                rows={5}
                aria-invalid={!!fieldErrors.objection_handling}
              />
              {fieldErrors.objection_handling?.map((m) => (
                <p key={m} className="text-xs text-destructive">
                  {m}
                </p>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Q&A */}
        <Card>
          <CardHeader>
            <CardTitle>Çifte Pyetje–Përgjigje</CardTitle>
            <CardDescription>Mësoni ndihmësit përgjigje për pyetje të zakonshme.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {qaRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Ende nuk ka çifte. Shtoni një për të filluar.</p>
            ) : (
              <ul className="space-y-4">
                {qaRows.map((row) => (
                  <li
                    key={row.localId}
                    className="rounded-lg border border-border/80 bg-muted/20 p-4 dark:bg-muted/10"
                  >
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Çifti
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                        onClick={() => removeQARow(row.localId)}
                      >
                        <Trash2 className="size-4" />
                        Hiq
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor={`q-${row.localId}`}>Pyetja</Label>
                        <Textarea
                          id={`q-${row.localId}`}
                          value={row.question}
                          onChange={(e) => updateQARow(row.localId, { question: e.target.value })}
                          placeholder="Pyetja e klientit…"
                          rows={3}
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor={`a-${row.localId}`}>Përgjigja</Label>
                        <Textarea
                          id={`a-${row.localId}`}
                          value={row.answer}
                          onChange={(e) => updateQARow(row.localId, { answer: e.target.value })}
                          placeholder="Përgjigja e ndihmësit…"
                          rows={3}
                        />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <Button type="button" variant="outline" onClick={addQARow}>
              <Plus className="size-4" />
              Shto çift Pyetje–Përgjigje
            </Button>
            {fieldErrors.qa_pairs?.map((m) => (
              <p key={m} className="text-xs text-destructive">
                {m}
              </p>
            ))}
          </CardContent>
        </Card>

        {/* Global toggle */}
        <Card className="border-primary/20 bg-primary/[0.03] dark:bg-primary/5">
          <CardContent className="flex flex-col gap-4 pt-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <BrainCircuit className="size-5 text-primary" />
                Agjenti IA aktiv
              </div>
              <p className="text-sm text-muted-foreground">
                Kur është fikur, personaliteti dhe rregullat e ruajtura mbeten për kur e ndizni përsëri.
              </p>
            </div>
            <div className="flex items-center gap-3 sm:flex-col sm:items-end sm:gap-1">
              <Switch
                checked={isActive}
                onCheckedChange={(v) => setIsActive(Boolean(v))}
                aria-label="Agjenti IA aktiv"
                size="default"
              />
              <span className="text-sm font-medium text-muted-foreground">
                {isActive ? 'Aktiv' : 'Fikur'}
              </span>
            </div>
          </CardContent>
        </Card>

        {(clientError || serverFieldMessages.length > 0) && (
          <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {clientError && <p>{clientError}</p>}
            {serverFieldMessages.map((m) => (
              <p key={m}>{m}</p>
            ))}
          </div>
        )}

        <Button type="submit" size="lg" disabled={saveMutation.isPending} className="min-w-[200px]">
          {saveMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          {saveMutation.isPending ? 'Saving...' : 'Save all changes'}
        </Button>
      </form>

      {/* Test panel — outside form submit */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <SendHorizontal className="size-5 text-muted-foreground" />
            <CardTitle>Test your AI</CardTitle>
          </div>
          <CardDescription>
            Dërgon një mesazh të vetëm duke përdorur <strong>vlerat aktuale të formularit</strong> — asgjë nuk ruhet te
            klientët.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="test-message">Test message</Label>
            <Textarea
              id="test-message"
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder='Provoni: "A shesni këpucë?"'
              rows={3}
            />
          </div>
          <Button
            type="button"
            onClick={handleSendTest}
            disabled={testMutation.isPending}
          >
            {testMutation.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <SendHorizontal className="size-4" />
            )}
            {testMutation.isPending ? 'Sending...' : 'Send test'}
          </Button>

          <div className="space-y-3 border-t border-border pt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Përgjigja
            </p>
            {testReply ? (
              <div className="flex w-full flex-col items-end gap-1">
                <div
                  className={cn(
                    'max-w-[min(100%,36rem)] rounded-2xl rounded-br-md border border-primary/15 px-3.5 py-2.5 text-sm',
                    'bg-primary text-primary-foreground',
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{testReply}</p>
                </div>
                <span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-[0.65rem] font-medium text-violet-700 dark:bg-violet-400/20 dark:text-violet-200">
                  AI preview
                </span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Ekzekutoni një test për të parë përgjigjen e ndihmësit këtu.
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
