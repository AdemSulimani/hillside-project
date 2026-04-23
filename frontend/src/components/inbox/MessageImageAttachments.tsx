import { useCallback, useMemo, useState } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';
import { cn } from '@/lib/utils';

export interface MessageImageAttachmentsProps {
  urls: string[];
  align: 'start' | 'end';
  className?: string;
}

function attachmentKindFromUrl(url: string): 'image' | 'audio' | 'link' {
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = url.toLowerCase();
  }
  if (/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(pathname)) return 'image';
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus|oga)$/i.test(pathname)) return 'audio';
  return 'link';
}

function linkLabelFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').pop();
    if (base && base.length > 0) return decodeURIComponent(base);
  } catch {
    /* fall through */
  }
  return 'Open attachment';
}

export function MessageImageAttachments({ urls, align, className }: MessageImageAttachmentsProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const ordered = useMemo(() => urls.filter(Boolean), [urls]);

  const imageSlides = useMemo(
    () => ordered.filter((src) => attachmentKindFromUrl(src) === 'image').map((src) => ({ src })),
    [ordered],
  );

  const openAt = useCallback((i: number) => {
    setIndex(i);
    setOpen(true);
  }, []);

  if (ordered.length === 0) return null;

  const linkClass = cn(
    'max-w-[min(100%,14rem)] truncate text-xs underline underline-offset-2',
    align === 'start' ? 'text-primary' : 'text-primary-foreground',
  );

  return (
    <>
      <div
        className={cn(
          'flex flex-wrap gap-1.5',
          align === 'start' ? 'justify-start' : 'justify-end',
          className,
        )}
      >
        {ordered.map((url, i) => {
          const kind = attachmentKindFromUrl(url);
          if (kind === 'audio') {
            return (
              <audio
                key={`audio:${i}:${url}`}
                controls
                src={url}
                className="h-9 min-w-[min(100%,12rem)] max-w-full shrink-0 rounded-md border border-border/80 bg-muted/40"
                preload="metadata"
              >
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {linkLabelFromUrl(url)}
                </a>
              </audio>
            );
          }
          if (kind === 'link') {
            return (
              <a
                key={`link:${i}:${url}`}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className={linkClass}
              >
                {linkLabelFromUrl(url)}
              </a>
            );
          }
          const imageIndex = imageSlides.findIndex((s) => s.src === url);
          return (
            <button
              key={`${url}-${i}`}
              type="button"
              className={cn(
                'relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-muted/40',
                'ring-offset-background transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              )}
              onClick={() => openAt(imageIndex)}
              aria-label={`View image ${imageIndex + 1} of ${imageSlides.length}`}
            >
              <img src={url} alt="" className="size-full object-cover" loading="lazy" />
            </button>
          );
        })}
      </div>
      {imageSlides.length > 0 ? (
        <Lightbox
          open={open}
          close={() => setOpen(false)}
          index={index}
          slides={imageSlides}
          on={{ view: ({ index: next }) => setIndex(next) }}
        />
      ) : null}
    </>
  );
}
