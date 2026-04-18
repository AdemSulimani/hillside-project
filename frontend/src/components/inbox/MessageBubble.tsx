import { useMemo, useState, useEffect } from 'react';
import { Link2, ShoppingBag, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import type { InboxMessage } from '@/types/conversation';
import {
  attachmentUrlsAfterRichUse,
  parseInstagramRichDisplay,
  type InstagramRichParsed,
} from '@/lib/instagramRichMessageDisplay';
import { AiMessageFeedbackForm } from '@/components/inbox/AiMessageFeedbackForm';
import { MessageImageAttachments } from '@/components/inbox/MessageImageAttachments';
import { Button } from '@/components/ui/button';

interface MessageBubbleProps {
  message: InboxMessage;
  agentDisplayName: string;
  /** Emphasize AI messages that failed automated quality checks. */
  qualityFlagged?: boolean;
}

function displayUrlHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.length > 42 ? `${url.slice(0, 40)}…` : url;
  }
}

function InstagramRichBody({
  parsed,
  variant,
}: {
  parsed: InstagramRichParsed;
  variant: 'inbound' | 'outbound';
}) {
  const isIn = variant === 'inbound';
  const cardBorder = isIn ? 'border-border/80 bg-background/95' : 'border-primary-foreground/25 bg-primary-foreground/10';
  const muted = isIn ? 'text-muted-foreground' : 'text-primary-foreground/75';
  const strong = isIn ? 'text-foreground' : 'text-primary-foreground';
  const linkClass = isIn
    ? 'text-primary underline-offset-2 hover:underline'
    : 'text-primary-foreground underline underline-offset-2 hover:opacity-90';

  const userCaptionBlock =
    parsed.userCaption != null && parsed.userCaption.trim() !== '' ? (
      <p className={cn('mt-2 whitespace-pre-wrap break-words text-sm', strong)}>{parsed.userCaption}</p>
    ) : null;

  if (parsed.kind === 'post_share') {
    return (
      <div className="space-y-2">
        <div className={cn('overflow-hidden rounded-lg border', cardBorder)}>
          <div className="flex gap-2.5 p-2.5">
            {parsed.thumbnailUrl ? (
              <img
                src={parsed.thumbnailUrl}
                alt=""
                className="size-14 shrink-0 rounded-md border border-border/60 object-cover"
                loading="lazy"
              />
            ) : (
              <div
                className={cn(
                  'flex size-14 shrink-0 items-center justify-center rounded-md border border-dashed',
                  isIn ? 'border-border/80 bg-muted/50' : 'border-primary-foreground/30 bg-primary-foreground/5',
                )}
              >
                <Link2 className={cn('size-5', muted)} aria-hidden />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className={cn('line-clamp-2 text-sm font-medium leading-snug', strong)}>{parsed.title}</p>
              <a
                href={parsed.url}
                target="_blank"
                rel="noopener noreferrer"
                className={cn('mt-1 block truncate text-xs', linkClass)}
              >
                {displayUrlHost(parsed.url)}
              </a>
            </div>
          </div>
          {parsed.description ? (
            <p className={cn('border-t border-border/50 px-2.5 py-2 text-xs leading-relaxed', muted, !isIn && 'border-primary-foreground/20')}>
              {parsed.description}
            </p>
          ) : null}
        </div>
        {userCaptionBlock}
      </div>
    );
  }

  if (parsed.kind === 'story_mention' || parsed.kind === 'story_reply') {
    const label = parsed.kind === 'story_mention' ? 'Story mention' : 'Story reply';
    const badgeClass = isIn
      ? 'bg-violet-500/15 text-violet-800 dark:bg-violet-400/20 dark:text-violet-100'
      : 'bg-primary-foreground/20 text-primary-foreground';

    return (
      <div className="space-y-2">
        <div
          className={cn(
            'flex flex-wrap gap-2',
            isIn ? 'items-start' : 'items-start justify-end',
          )}
        >
          <span
            className={cn(
              'inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold tracking-tight',
              badgeClass,
            )}
          >
            {label}
          </span>
          {parsed.previewUrl ? (
            <MessageImageAttachments
              urls={[parsed.previewUrl]}
              align={isIn ? 'start' : 'end'}
              className="-mt-0.5"
            />
          ) : null}
        </div>
        {parsed.extraRichLines ? (
          <p className={cn('whitespace-pre-wrap text-xs leading-relaxed', muted)}>{parsed.extraRichLines}</p>
        ) : null}
        {userCaptionBlock}
      </div>
    );
  }

  if (parsed.kind === 'reel_share') {
    const badgeClass = isIn
      ? 'bg-sky-500/15 text-sky-900 dark:bg-sky-400/15 dark:text-sky-100'
      : 'bg-primary-foreground/20 text-primary-foreground';

    return (
      <div className="space-y-2">
        <div className="flex flex-col items-start gap-1.5">
          <span
            className={cn(
              'inline-flex rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold tracking-tight',
              badgeClass,
            )}
          >
            Reel shared
          </span>
          <p className={cn('text-sm font-semibold leading-snug', strong)}>{parsed.title}</p>
          {parsed.description ? (
            <p className={cn('whitespace-pre-wrap text-xs leading-relaxed', muted)}>{parsed.description}</p>
          ) : null}
        </div>
        {userCaptionBlock}
      </div>
    );
  }

  if (parsed.kind === 'product_tag') {
    const productShell = isIn
      ? 'border-emerald-600/25 bg-emerald-600/[0.07] dark:border-emerald-400/30 dark:bg-emerald-400/10'
      : 'border-primary-foreground/25 bg-primary-foreground/10';

    return (
      <div className="space-y-2">
        <div className={cn('rounded-lg border p-3', productShell)}>
          <div className="flex items-start gap-2.5">
            <div
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-md border',
                isIn ? 'border-emerald-600/30 bg-emerald-600/10 dark:border-emerald-400/35' : 'border-primary-foreground/25',
              )}
            >
              <ShoppingBag className={cn('size-4', isIn ? 'text-emerald-800 dark:text-emerald-200' : 'text-primary-foreground')} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn('text-[0.65rem] font-semibold uppercase tracking-wide', muted)}>Product</p>
              <p className={cn('mt-0.5 text-sm font-semibold leading-snug', strong)}>{parsed.productName}</p>
              {parsed.subtitle ? (
                <p className={cn('mt-1 whitespace-pre-wrap text-xs leading-relaxed', muted)}>{parsed.subtitle}</p>
              ) : null}
            </div>
          </div>
        </div>
        {userCaptionBlock}
      </div>
    );
  }

  return null;
}

export function MessageBubble({
  message,
  agentDisplayName,
  qualityFlagged = false,
}: MessageBubbleProps) {
  const isInbound = message.direction === 'inbound';
  const hasAttachments = message.attachment_urls.length > 0;
  const text =
    message.content?.trim() ||
    (hasAttachments ? '' : message.type !== 'text' ? `[${message.type}]` : '');
  const time = formatRelativeShort(message.created_at);

  const richParsed = useMemo(
    () => parseInstagramRichDisplay(message.content, message.attachment_urls),
    [message.content, message.attachment_urls],
  );

  const attachmentUrlsForGallery = useMemo(
    () => (richParsed ? attachmentUrlsAfterRichUse(richParsed, message.attachment_urls) : message.attachment_urls),
    [richParsed, message.attachment_urls],
  );

  const hasGallery = attachmentUrlsForGallery.length > 0;

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
          {richParsed ? (
            <InstagramRichBody parsed={richParsed} variant="inbound" />
          ) : text ? (
            <p className="whitespace-pre-wrap break-words">{text}</p>
          ) : null}
          {hasGallery ? (
            <MessageImageAttachments
              urls={attachmentUrlsForGallery}
              align="start"
              className={richParsed || text ? 'mt-2' : undefined}
            />
          ) : null}
          {!richParsed && !text && !hasGallery ? (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">[Empty message]</p>
          ) : null}
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
          'group/bubble relative max-w-[min(100%,28rem)] rounded-2xl rounded-br-md border px-3.5 py-2.5 text-sm',
          qualityFlagged
            ? 'border-orange-400/80 bg-orange-500/15 text-foreground ring-2 ring-orange-400/35 dark:border-orange-500/50 dark:bg-orange-950/40 dark:text-foreground'
            : 'border-primary/15 bg-primary text-primary-foreground',
        )}
      >
        {isAi ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className={cn(
              'absolute top-1 right-1 opacity-0 transition-opacity',
              qualityFlagged
                ? 'text-foreground/70 hover:bg-foreground/10 hover:text-foreground group-hover/bubble:opacity-100 focus-visible:opacity-100'
                : 'text-primary-foreground/70 hover:bg-primary-foreground/15 hover:text-primary-foreground group-hover/bubble:opacity-100 focus-visible:opacity-100',
            )}
            aria-expanded={feedbackOpen}
            aria-label={feedbackOpen ? 'Hide feedback form' : 'Flag incorrect AI response'}
            onClick={() => setFeedbackOpen((open) => !open)}
          >
            <ThumbsDown className="size-3.5" />
          </Button>
        ) : null}
        {richParsed ? (
          <InstagramRichBody parsed={richParsed} variant="outbound" />
        ) : text ? (
          <p
            className={cn(
              'whitespace-pre-wrap break-words',
              isAi && 'pr-8',
              !qualityFlagged && 'text-primary-foreground',
            )}
          >
            {text}
          </p>
        ) : null}
        {hasGallery ? (
          <MessageImageAttachments
            urls={attachmentUrlsForGallery}
            align="end"
            className={richParsed || text ? 'mt-2' : undefined}
          />
        ) : null}
        {!richParsed && !text && !hasGallery ? (
          <p
            className={cn(
              'whitespace-pre-wrap break-words',
              isAi && 'pr-8',
              qualityFlagged ? 'text-muted-foreground' : 'text-primary-foreground/80',
            )}
          >
            [Empty message]
          </p>
        ) : null}
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
