import { Globe, Image, MessageCircleMore } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeShort, isWithinLastHours } from '@/lib/formatRelativeTime';
import type { ChannelType, ConversationSummary } from '@/types/conversation';

function channelIcon(type: ChannelType) {
  if (type === 'facebook') return Globe;
  if (type === 'instagram') return Image;
  return MessageCircleMore;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function simplifiedUnread(c: ConversationSummary): boolean {
  if (c.has_outbound_message) return false;
  return isWithinLastHours(c.last_message_at, 1);
}

interface ConversationListItemProps {
  conversation: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
}

export function ConversationListItem({ conversation, selected, onSelect }: ConversationListItemProps) {
  const ChannelIcon = channelIcon(conversation.channel_type);
  const previewSource =
    conversation.last_message_content?.trim() ||
    (conversation.last_message_created_at ? '(No text)' : 'No messages yet');
  const preview = truncate(previewSource, 72);
  const timeLabel = formatRelativeShort(
    conversation.last_message_created_at ?? conversation.last_message_at,
  );
  const unread = simplifiedUnread(conversation);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected
          ? 'border-primary/30 bg-primary/5'
          : 'border-transparent bg-transparent hover:bg-muted/60',
      )}
    >
      <div className="relative shrink-0">
        <div className="flex size-11 items-center justify-center overflow-hidden rounded-full bg-muted">
          {conversation.contact_avatar_url ? (
            <img
              src={conversation.contact_avatar_url}
              alt=""
              className="size-full object-cover"
            />
          ) : (
            <span className="text-sm font-semibold text-muted-foreground">
              {conversation.contact_name.slice(0, 1).toUpperCase() || '?'}
            </span>
          )}
        </div>
        <div
          className="absolute -right-0.5 -bottom-0.5 flex size-5 items-center justify-center rounded-full border-2 border-background bg-background shadow-sm"
          title={conversation.channel_type}
        >
          <ChannelIcon className="size-3 text-muted-foreground" />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate font-medium text-foreground">{conversation.contact_name}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            {unread && (
              <span
                className="size-2 rounded-full bg-primary"
                title="Unread"
                aria-label="Unread"
              />
            )}
            {timeLabel ? (
              <span className="text-xs tabular-nums text-muted-foreground">{timeLabel}</span>
            ) : null}
          </div>
        </div>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{preview}</p>
      </div>
    </button>
  );
}
