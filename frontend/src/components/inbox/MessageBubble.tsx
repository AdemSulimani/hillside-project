import { useEffect, useState } from 'react';
import { ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import type { InboxMessage } from '@/types/conversation';
import { AiMessageFeedbackForm } from '@/components/inbox/AiMessageFeedbackForm';
import { Button } from '@/components/ui/button';

interface MessageBubbleProps {
  message: InboxMessage;
  agentDisplayName: string;
}

export function MessageBubble({ message, agentDisplayName }: MessageBubbleProps) {
  const isInbound = message.direction === 'inbound';
  const text = message.content?.trim() || (message.type !== 'text' ? `[${message.type}]` : '');
  const time = formatRelativeShort(message.created_at);

  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    setFeedbackOpen(false);
  }, [message.id]);

  if (isInbound) {
    return (
      <div className="flex w-full flex-col items-start gap-1">
        <div
          className={cn(
            'max-w-[min(100%,28rem)] rounded-2xl rounded-bl-md px-3.5 py-2.5 text-sm',
            'bg-muted text-foreground',
          )}
        >
          <p className="whitespace-pre-wrap break-words">{text}</p>
        </div>
        {time ? <span className="px-1 text-[0.65rem] text-muted-foreground">{time}</span> : null}
      </div>
    );
  }

  const isAi = message.sent_by === 'ai';
  const label = isAi ? 'AI' : agentDisplayName || 'You';

  return (
    <div className="flex w-full flex-col items-end gap-1">
      <div
        className={cn(
          'group/bubble relative max-w-[min(100%,28rem)] rounded-2xl rounded-br-md border border-primary/15 px-3.5 py-2.5 text-sm',
          'bg-primary text-primary-foreground',
        )}
      >
        {isAi ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              'absolute top-1 right-1 text-primary-foreground/70 opacity-0 transition-opacity',
              'hover:bg-primary-foreground/15 hover:text-primary-foreground',
              'group-hover/bubble:opacity-100 focus-visible:opacity-100',
            )}
            aria-expanded={feedbackOpen}
            aria-label={feedbackOpen ? 'Hide feedback form' : 'Flag incorrect AI response'}
            onClick={() => setFeedbackOpen((open) => !open)}
          >
            <ThumbsDown className="size-3.5" />
          </Button>
        ) : null}
        <p className={cn('whitespace-pre-wrap break-words', isAi && 'pr-8')}>{text}</p>
      </div>
      <div className="flex w-full max-w-[min(100%,28rem)] flex-col items-end gap-1">
        <div className="flex items-center gap-2 pr-0.5">
          <span
            className={cn(
              'rounded-md px-1.5 py-0.5 text-[0.65rem] font-medium',
              isAi
                ? 'bg-violet-500/15 text-violet-700 dark:bg-violet-400/20 dark:text-violet-200'
                : 'bg-emerald-600/15 text-emerald-800 dark:bg-emerald-400/20 dark:text-emerald-100',
            )}
          >
            {label}
          </span>
          {time ? <span className="text-[0.65rem] text-muted-foreground">{time}</span> : null}
        </div>
        {isAi && feedbackOpen ? (
          <AiMessageFeedbackForm
            messageId={message.id}
            onCancel={() => setFeedbackOpen(false)}
            onSubmitted={() => setFeedbackOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}
