import { useState } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

interface ReplyBoxProps {
  disabled?: boolean;
  disabledReason?: string;
  aiPaused: boolean;
  sending: boolean;
  onSend: (text: string) => void | Promise<void>;
}

export function ReplyBox({
  disabled = false,
  disabledReason,
  aiPaused,
  sending,
  onSend,
}: ReplyBoxProps) {
  const [text, setText] = useState('');

  async function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled || sending) return;
    setText('');
    try {
      await onSend(trimmed);
    } catch {
      // Error is handled by the mutation's onError (toast)
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
          {aiPaused ? 'AI paused for this conversation' : 'AI active'}
        </span>
      </div>
      {disabled && disabledReason ? (
        <p className="mb-2 text-xs text-muted-foreground">{disabledReason}</p>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={disabled ? 'Reopen conversation to reply…' : 'Type a message…'}
          disabled={disabled || sending}
          rows={3}
          className="min-h-[4.5rem] flex-1 resize-none"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
        />
        <Button
          type="button"
          className="shrink-0 sm:mb-0.5"
          disabled={disabled || sending || !text.trim()}
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
