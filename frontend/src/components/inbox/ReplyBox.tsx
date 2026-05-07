import { useCallback, useId, useRef, useState } from 'react';
import { Loader2, Paperclip, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export interface ReplySendPayload {
  text: string;
  files: File[];
}

interface ReplyBoxProps {
  disabled?: boolean;
  disabledReason?: string;
  aiPaused: boolean;
  sending: boolean;
  onSend: (payload: ReplySendPayload) => void | Promise<void>;
}

const ACCEPT_IMAGES = 'image/jpeg,image/png,image/webp';
const MAX_ATTACHMENTS = 10;

type PendingFile = { id: string; file: File; previewUrl: string };

export function ReplyBox({
  disabled = false,
  disabledReason,
  aiPaused,
  sending,
  onSend,
}: ReplyBoxProps) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const trimmed = text.trim();
  const canSend = (trimmed.length > 0 || pending.length > 0) && !disabled && !sending;

  const removePending = useCallback((id: string) => {
    setPending((prev) => {
      const item = prev.find((p) => p.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files;
    if (!list?.length) return;

    const next: PendingFile[] = [];
    for (let i = 0; i < list.length; i++) {
      const file = list.item(i);
      if (!file) continue;
      if (!file.type.startsWith('image/')) continue;
      if (pending.length + next.length >= MAX_ATTACHMENTS) break;
      next.push({
        id: `${Date.now()}-${i}-${file.name}`,
        file,
        previewUrl: URL.createObjectURL(file),
      });
    }

    if (next.length) {
      setPending((prev) => [...prev, ...next].slice(0, MAX_ATTACHMENTS));
    }
    e.target.value = '';
  };

  async function handleSend() {
    if (!canSend) return;

    const snapshot = [...pending];
    const files = snapshot.map((p) => p.file);
    const textToSend = trimmed;

    try {
      await onSend({ text: textToSend, files });
      for (const p of snapshot) {
        URL.revokeObjectURL(p.previewUrl);
      }
      setPending([]);
      setText('');
    } catch {
      // Error toast handled by mutation onError
    }
  }

  return (
    <div className="border-t border-border bg-background p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">Reply as human</span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 font-medium',
            aiPaused
              ? 'bg-amber-500/15 text-amber-900 dark:bg-amber-400/15 dark:text-amber-100'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {aiPaused ? 'Human reply window (AI on hold)' : 'No human hold'}
        </span>
      </div>
      {disabled && disabledReason ? (
        <p className="mb-2 text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}

      {pending.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2">
          {pending.map((p) => (
            <div
              key={p.id}
              className="relative size-14 shrink-0 overflow-hidden rounded-md border border-border bg-muted/40"
            >
              <img
                src={p.previewUrl}
                alt=""
                className="size-full object-cover"
                loading="lazy"
                decoding="async"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon-xs"
                className="absolute top-0.5 right-0.5 size-6 rounded-full shadow-sm"
                disabled={sending}
                aria-label="Remove image"
                onClick={() => removePending(p.id)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <input
          id={inputId}
          ref={fileInputRef}
          type="file"
          accept={ACCEPT_IMAGES}
          multiple
          className="sr-only"
          onChange={onPickFiles}
          disabled={disabled || sending}
        />
        <div className="flex min-h-[4.5rem] flex-1 gap-1 rounded-md border border-input bg-background ring-offset-background focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mt-1 shrink-0 self-start text-muted-foreground hover:text-foreground"
            disabled={disabled || sending || pending.length >= MAX_ATTACHMENTS}
            aria-label="Attach images"
            title="Attach images"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={disabled ? 'Reopen this conversation to reply…' : 'Write a message…'}
            disabled={disabled || sending}
            rows={3}
            className="min-h-[4.5rem] flex-1 resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
          />
        </div>
        <Button
          type="button"
          className="shrink-0 sm:mb-0.5"
          disabled={!canSend}
          onClick={() => void handleSend()}
        >
          {sending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <>
              <Send className="size-4" />
              Send
            </>
          )}
        </Button>
      </div>
    </div>
  );
}
