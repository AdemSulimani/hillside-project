import { Loader2, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ConversationAiStatusBarProps {
  aiPaused: boolean;
  disabled?: boolean;
  togglePending: boolean;
  onToggle: () => void;
}

export function ConversationAiStatusBar({
  aiPaused,
  disabled = false,
  togglePending,
  onToggle,
}: ConversationAiStatusBarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-sm',
        aiPaused ? 'bg-destructive/5' : 'bg-emerald-500/5',
      )}
    >
      <p
        className={cn(
          'min-w-0 font-medium',
          aiPaused ? 'text-destructive' : 'text-emerald-800 dark:text-emerald-200',
        )}
      >
        {aiPaused
          ? 'AI is paused for this conversation'
          : 'AI is replying in this conversation'}
      </p>
      <Button
        type="button"
        size="sm"
        variant={aiPaused ? 'default' : 'outline'}
        className="shrink-0"
        disabled={disabled || togglePending}
        onClick={onToggle}
      >
        {togglePending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : aiPaused ? (
          <>
            <Play className="size-4" />
            Resume AI
          </>
        ) : (
          <>
            <Pause className="size-4" />
            Pause AI
          </>
        )}
      </Button>
    </div>
  );
}
