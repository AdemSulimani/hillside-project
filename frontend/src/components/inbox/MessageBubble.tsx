import { cn } from '@/lib/utils';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import type { InboxMessage } from '@/types/conversation';

interface MessageBubbleProps {
  message: InboxMessage;
  agentDisplayName: string;
}

export function MessageBubble({ message, agentDisplayName }: MessageBubbleProps) {
  const isInbound = message.direction === 'inbound';
  const text = message.content?.trim() || (message.type !== 'text' ? `[${message.type}]` : '');
  const time = formatRelativeShort(message.created_at);

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
          'max-w-[min(100%,28rem)] rounded-2xl rounded-br-md border border-primary/15 px-3.5 py-2.5 text-sm',
          'bg-primary text-primary-foreground',
        )}
      >
        <p className="whitespace-pre-wrap break-words">{text}</p>
      </div>
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
    </div>
  );
}
