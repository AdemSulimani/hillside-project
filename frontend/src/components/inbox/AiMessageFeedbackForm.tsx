import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AxiosError } from 'axios';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { submitFeedback } from '@/api/feedbackApi';
import { FEEDBACK_REASON_OPTIONS } from '@/components/inbox/feedbackOptions';
import type { FeedbackReasonOption } from '@/types/feedback';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const selectClasses =
  'h-10 w-full appearance-none rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50';

function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof AxiosError && err.response?.data?.message) {
    return String(err.response.data.message);
  }
  return fallback;
}

interface AiMessageFeedbackFormProps {
  messageId: string;
  onCancel: () => void;
  onSubmitted: () => void;
}

export function AiMessageFeedbackForm({ messageId, onCancel, onSubmitted }: AiMessageFeedbackFormProps) {
  const queryClient = useQueryClient();
  const [corrected, setCorrected] = useState('');
  const [reason, setReason] = useState<FeedbackReasonOption>(FEEDBACK_REASON_OPTIONS[0].value);
  const [clientError, setClientError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      submitFeedback({
        message_id: messageId,
        corrected_response: corrected.trim(),
        reason,
      }),
    onSuccess: async () => {
      setClientError(null);
      await queryClient.invalidateQueries({ queryKey: ['ai-config'] });
      await queryClient.invalidateQueries({ queryKey: ['feedback-logs'] });
      toast.success('Faleminderit — komenti juaj u ruajt.');
      onSubmitted();
    },
    onError: (err: unknown) => {
      toast.error(extractMessage(err, 'Nuk mund të dërgohet komenti'));
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = corrected.trim();
    if (!trimmed) {
      setClientError('Përshkruani çfarë duhet të kishte thënë IA-ja.');
      return;
    }
    if (trimmed.length > 16_000) {
      setClientError('Ju lutemi mbajeni përgjigjen e korrigjuar nën 16.000 karaktere.');
      return;
    }
    setClientError(null);
    mutation.mutate();
  }

  function handleCancel() {
    setCorrected('');
    setReason(FEEDBACK_REASON_OPTIONS[0].value);
    setClientError(null);
    onCancel();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-1 w-full max-w-[min(100%,28rem)] space-y-3 rounded-lg border border-border bg-card p-3 text-left text-foreground shadow-sm"
    >
      <div className="space-y-2">
        <Label htmlFor={`feedback-corrected-${messageId}`}>Çfarë duhet të kishte thënë IA-ja?</Label>
        <Textarea
          id={`feedback-corrected-${messageId}`}
          value={corrected}
          onChange={(e) => {
            setCorrected(e.target.value);
            if (clientError) setClientError(null);
          }}
          placeholder="Shkruani përgjigjen ideale…"
          rows={4}
          maxLength={16_000}
          aria-invalid={!!clientError}
          className="min-h-[5.5rem] resize-y"
        />
        {clientError ? <p className="text-xs text-destructive">{clientError}</p> : null}
      </div>

      <div className="space-y-2">
        <Label htmlFor={`feedback-reason-${messageId}`}>Arsyeja</Label>
        <select
          id={`feedback-reason-${messageId}`}
          value={reason}
          onChange={(e) => setReason(e.target.value as FeedbackReasonOption)}
          className={selectClasses}
        >
          {FEEDBACK_REASON_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap justify-end gap-2 pt-1">
        <Button type="button" variant="outline" size="sm" onClick={handleCancel} disabled={mutation.isPending}>
          Anulo
        </Button>
        <Button type="submit" size="sm" disabled={mutation.isPending}>
          {mutation.isPending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" data-icon="inline-start" />
              Duke dërguar…
            </>
          ) : (
            'Dërgo'
          )}
        </Button>
      </div>
    </form>
  );
}
