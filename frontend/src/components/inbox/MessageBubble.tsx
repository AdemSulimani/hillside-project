import { useEffect, useMemo, useState } from 'react';
import { Link2, Pencil, RefreshCw, ShoppingBag, ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeShort } from '@/lib/formatRelativeTime';
import type { InboxMessage, MessageReplyTo } from '@/types/conversation';
import {
  attachmentUrlsAfterRichUse,
  parseInstagramRichDisplay,
  type InstagramRichParsed,
} from '@/lib/instagramRichMessageDisplay';
import { AiMessageFeedbackForm } from '@/components/inbox/AiMessageFeedbackForm';
import { MessageImageAttachments } from '@/components/inbox/MessageImageAttachments';
import { Button, buttonVariants } from '@/components/ui/button';

interface MessageBubbleProps {
  message: InboxMessage;
  agentDisplayName: string;
  /** Contact display name (for reply-quote label when the quoted message is inbound). */
  contactDisplayName: string;
  /** Emphasize AI messages that failed automated quality checks. */
  qualityFlagged?: boolean;
}

const REPLY_PREVIEW_MAX = 60;

function isSharedPostReplyContent(content: string | null | undefined): boolean {
  return (content ?? '').trimStart().startsWith('Customer shared a post');
}

function isLikelyHttpImageUrl(url: string): boolean {
  const u = url.toLowerCase();
  if (!u.startsWith('http://') && !u.startsWith('https://')) return false;
  if (u.endsWith('.mp4') || u.includes('.mp4?')) return false;
  if (u.endsWith('.webm') || u.includes('.webm?')) return false;
  if (u.includes('/video/upload/') || u.includes('mime_video') || u.includes('resource_type=video')) {
    return false;
  }
  return (
    /\.(jpe?g|png|gif|webp|avif|heic|heif)(\?|$|#)/i.test(u) ||
    u.includes('image/upload') ||
    u.includes('/image/') ||
    (u.includes('cloudinary.com') && u.includes('/image/'))
  );
}

function shouldShowReplyThumbnail(replyTo: MessageReplyTo): boolean {
  if (!replyTo.attachment_url || !isLikelyHttpImageUrl(replyTo.attachment_url)) return false;
  if (isSharedPostReplyContent(replyTo.content)) return false;
  const t = (replyTo.content ?? '').trim();
  if (!t) return true;
  if (/^\[(image|video|document|audio) attachment\]$/i.test(t)) return true;
  if (t === '[Message]') return true;
  return false;
}

function replyQuoteLabel(replyTo: MessageReplyTo, contactDisplayName: string): string {
  if (replyTo.direction === 'outbound') return 'Ju';
  return contactDisplayName.trim() || 'Klienti';
}

function truncateReplyPreview(text: string, max = REPLY_PREVIEW_MAX): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}...`;
}

const EDITED_TOOLTIP_MAX = 280;

function buildEditedTooltip(message: InboxMessage): string {
  const original = (message.original_content ?? '').trim();
  if (!original) {
    return message.edit_count > 1 ? `E redaktuar ${message.edit_count} herë` : 'E redaktuar';
  }
  const truncated =
    original.length > EDITED_TOOLTIP_MAX
      ? `${original.slice(0, EDITED_TOOLTIP_MAX - 1).trimEnd()}…`
      : original;
  const timesLabel =
    message.edit_count > 1 ? ` · redaktuar ${message.edit_count} herë` : '';
  return `Mesazhi origjinal${timesLabel}:\n${truncated}`;
}

/**
 * Inline "edited" tag rendered alongside the timestamp on a bubble. Hover reveals the original
 * pre-edit content via the native `title` attribute — sufficient as an audit cue without
 * pulling in a popover dependency.
 */
function EditedIndicator({
  message,
  variant,
}: {
  message: InboxMessage;
  variant: 'inbound' | 'outbound';
}) {
  if (message.edit_count <= 0) return null;
  return (
    <span
      className={cn(
        'inline-flex cursor-help items-center gap-0.5 text-[0.65rem]',
        variant === 'inbound'
          ? 'text-muted-foreground'
          : 'text-muted-foreground',
      )}
      title={buildEditedTooltip(message)}
      aria-label={buildEditedTooltip(message)}
    >
      <Pencil className="size-2.5" aria-hidden />
      e redaktuar
    </span>
  );
}

function ReplyQuotePreview({
  replyTo,
  contactDisplayName,
  bubbleVariant,
}: {
  replyTo: MessageReplyTo;
  contactDisplayName: string;
  bubbleVariant: 'inbound' | 'outbound';
}) {
  const isIn = bubbleVariant === 'inbound';
  const borderClass = isIn ? 'border-l-[3px] border-l-muted-foreground/50' : 'border-l-[3px] border-l-primary';
  const label = replyQuoteLabel(replyTo, contactDisplayName);
  const sharedPost = isSharedPostReplyContent(replyTo.content);
  const showThumb = shouldShowReplyThumbnail(replyTo);
  const previewText = sharedPost ? 'Post i ndarë' : truncateReplyPreview(replyTo.content ?? '') || '…';

  return (
    <div
      className={cn(
        'ml-1 w-full shrink-0 rounded-t-xl border-b px-2.5 py-2',
        borderClass,
        isIn
          ? 'bg-muted/60 text-foreground'
          : 'bg-primary-foreground/[0.12] text-primary-foreground',
      )}
    >
      <p
        className={cn(
          'text-[0.65rem] font-semibold tracking-tight',
          isIn ? 'text-muted-foreground' : 'text-primary-foreground/80',
        )}
      >
        {label}
      </p>
      {showThumb ? (
        <img
          src={replyTo.attachment_url!}
          alt=""
          className="mt-1.5 size-10 rounded-md border border-border/40 object-cover"
          loading="lazy"
        />
      ) : (
        <p
          className={cn(
            'mt-1 line-clamp-2 text-[0.8rem] leading-snug',
            isIn ? 'text-foreground/90' : 'text-primary-foreground/95',
          )}
        >
          {previewText}
        </p>
      )}
    </div>
  );
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
  serverMediaType,
}: {
  parsed: InstagramRichParsed;
  variant: 'inbound' | 'outbound';
  serverMediaType?: string | null;
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

  if (
    parsed.kind === 'story_mention' ||
    parsed.kind === 'story_reply' ||
    parsed.kind === 'story_share'
  ) {
    const label =
      parsed.kind === 'story_mention'
        ? 'Përmendje historie'
        : parsed.kind === 'story_reply'
          ? 'Përgjigje historie'
          : 'Histori e ndarë';
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
              serverMediaType={serverMediaType}
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

  if (parsed.kind === 'generic_share') {
    const badgeClass = isIn
      ? 'bg-slate-500/15 text-slate-800 dark:bg-slate-400/20 dark:text-slate-100'
      : 'bg-primary-foreground/20 text-primary-foreground';

    return (
      <div className="space-y-2">
        <div
          className={cn(
            'flex flex-wrap items-start gap-2',
            isIn ? 'justify-start' : 'justify-end',
          )}
        >
          <span
            className={cn(
              'inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-[0.7rem] font-semibold tracking-tight',
              badgeClass,
            )}
          >
            Përmbajtje e ndarë
          </span>
          {parsed.previewUrl ? (
            <MessageImageAttachments
              urls={[parsed.previewUrl]}
              align={isIn ? 'start' : 'end'}
              className="-mt-0.5"
              serverMediaType={serverMediaType}
            />
          ) : null}
        </div>
        {parsed.title ? (
          <p className={cn('whitespace-pre-wrap text-sm leading-snug', strong)}>{parsed.title}</p>
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
            Reel i ndarë
          </span>
          {parsed.thumbnailUrl ? (
            <MessageImageAttachments
              urls={[parsed.thumbnailUrl]}
              align={isIn ? 'start' : 'end'}
              serverMediaType={serverMediaType}
            />
          ) : null}
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
              <p className={cn('text-[0.65rem] font-semibold uppercase tracking-wide', muted)}>Produkti</p>
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
  contactDisplayName,
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

  /* eslint-disable react-hooks/set-state-in-effect -- reset feedback when switching messages */
  useEffect(() => {
    setFeedbackOpen(false);
  }, [message.id]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (isInbound) {
    return (
      <div className="flex w-full flex-col items-start gap-1">
        <div
          className={cn(
            'flex max-w-[min(100%,28rem)] flex-col overflow-hidden',
            message.replyTo ? 'rounded-2xl rounded-bl-md border border-border/50' : '',
          )}
        >
          {message.replyTo ? (
            <ReplyQuotePreview
              replyTo={message.replyTo}
              contactDisplayName={contactDisplayName}
              bubbleVariant="inbound"
            />
          ) : null}
          <div
            className={cn(
              'px-3.5 py-2.5 text-sm',
              'bg-muted text-foreground',
              message.replyTo ? '' : 'max-w-[min(100%,28rem)] rounded-2xl rounded-bl-md',
              message.replyTo ? 'rounded-b-xl rounded-bl-md' : '',
            )}
          >
            {richParsed ? (
              <InstagramRichBody parsed={richParsed} variant="inbound" serverMediaType={message.type} />
            ) : text ? (
              <p className="whitespace-pre-wrap break-words">{text}</p>
            ) : null}
            {hasGallery ? (
              <MessageImageAttachments
                urls={attachmentUrlsForGallery}
                align="start"
                className={richParsed || text ? 'mt-2' : undefined}
                serverMediaType={message.type}
              />
            ) : null}
            {!richParsed && !text && !hasGallery ? (
              <p className="whitespace-pre-wrap break-words text-muted-foreground">[Mesazh bosh]</p>
            ) : null}
          </div>
        </div>
        {time || message.edit_count > 0 ? (
          <div className="flex items-center gap-1.5 px-1">
            {time ? <span className="text-[0.65rem] text-muted-foreground">{time}</span> : null}
            <EditedIndicator message={message} variant="inbound" />
          </div>
        ) : null}
      </div>
    );
  }

  const isAi = message.sent_by === 'ai';
  const label = isAi ? 'IA' : agentDisplayName || 'Ju';

  return (
    <div className="flex w-full flex-col items-end gap-1">
      <div className="relative flex max-w-[min(100%,28rem)] flex-col overflow-hidden rounded-2xl rounded-br-md">
        {message.replyTo ? (
          <ReplyQuotePreview
            replyTo={message.replyTo}
            contactDisplayName={contactDisplayName}
            bubbleVariant="outbound"
          />
        ) : null}
        <div
          className={cn(
            'group/bubble relative border px-3.5 py-2.5 text-sm',
            message.replyTo ? 'rounded-b-2xl rounded-br-md border-t-0' : 'rounded-2xl rounded-br-md',
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
            aria-label={feedbackOpen ? 'Fshih formularin e komenteve' : 'Shëno përgjigjen e gabuar të IA-së'}
            onClick={() => setFeedbackOpen((open) => !open)}
          >
            <ThumbsDown className="size-3.5" />
          </Button>
        ) : null}
        {richParsed ? (
          <InstagramRichBody parsed={richParsed} variant="outbound" serverMediaType={message.type} />
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
            serverMediaType={message.type}
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
            [Mesazh bosh]
          </p>
        ) : null}
        </div>
      </div>
      {message.send_status === 'failed' ? (
        <div
          className="flex max-w-[min(100%,28rem)] items-center justify-end gap-1 text-xs font-medium text-destructive"
          title={message.send_error ?? undefined}
        >
          <RefreshCw className="size-3.5 shrink-0 opacity-90" aria-hidden />
          <span>Dërgimi dështoi</span>
        </div>
      ) : null}
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
          <EditedIndicator message={message} variant="outbound" />
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

export function CancellationRefundConversationBanner({
  requestType,
}: {
  requestType: 'cancellation' | 'refund';
}) {
  return (
    <div className="border-b border-red-500/35 bg-red-500/10 px-4 py-3 dark:bg-red-950/35">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm font-medium text-foreground">
          Klienti kërkoi {requestType === 'cancellation' ? 'anulim' : 'rimbursim'}. IA-ja është ndalur. Trajtojeni nga moduli i porosive.
        </p>
        <a
          href="/orders?tab=action_required"
          className={cn(buttonVariants({ variant: 'destructive', size: 'sm' }), 'w-fit')}
        >
          Hap veprimin e nevojshëm
        </a>
      </div>
    </div>
  );
}
