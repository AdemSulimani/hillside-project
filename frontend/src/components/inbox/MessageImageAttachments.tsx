import { useCallback, useMemo, useState } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';
import { cn } from '@/lib/utils';

export interface MessageImageAttachmentsProps {
  urls: string[];
  align: 'start' | 'end';
  className?: string;
  /** When the URL has no file extension, use the server-stored message type (e.g. Instagram story MP4 on Backblaze). */
  serverMediaType?: string | null;
}

function attachmentKindFromUrl(url: string, serverMediaType?: string | null): 'image' | 'audio' | 'video' | 'link' {
  const lower = url.toLowerCase();
  let pathname = '';
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    pathname = lower;
  }
  if (/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(pathname)) return 'image';
  if (/\.(mp3|wav|ogg|m4a|aac|flac|opus|oga)$/i.test(pathname)) return 'audio';
  if (/\.(mp4|webm|mov|m4v|ogv)$/i.test(pathname)) return 'video';
  if (lower.includes('/video/upload/')) return 'video';
  if (lower.includes('/image/upload/')) return 'image';
  const st = (serverMediaType ?? '').toLowerCase();
  if (st === 'video') return 'video';
  if (st === 'image') return 'image';
  return 'link';
}

function linkLabelFromUrl(url: string): string {
  try {
    const base = new URL(url).pathname.split('/').pop();
    if (base && base.length > 0) return decodeURIComponent(base);
  } catch {
    /* fall through */
  }
  return 'Hap bashkëngjitjen';
}

export function MessageImageAttachments({ urls, align, className, serverMediaType }: MessageImageAttachmentsProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const ordered = useMemo(() => urls.filter(Boolean), [urls]);

  const imageSlides = useMemo(
    () =>
      ordered
        .filter((src) => attachmentKindFromUrl(src, serverMediaType) === 'image')
        .map((src) => ({ src })),
    [ordered, serverMediaType],
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
          const kind = attachmentKindFromUrl(url, serverMediaType);
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
          if (kind === 'video') {
            return (
              <video
                key={`video:${i}:${url}`}
                controls
                playsInline
                muted
                src={url}
                className="max-h-40 min-w-[min(100%,10rem)] max-w-[min(100%,14rem)] shrink-0 rounded-lg border border-border/80 bg-black/80 object-contain"
                preload="metadata"
              >
                <a href={url} target="_blank" rel="noopener noreferrer" className={linkClass}>
                  {linkLabelFromUrl(url)}
                </a>
              </video>
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
