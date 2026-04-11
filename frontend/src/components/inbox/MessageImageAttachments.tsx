import { useCallback, useMemo, useState } from 'react';
import Lightbox from 'yet-another-react-lightbox';
import 'yet-another-react-lightbox/styles.css';
import { cn } from '@/lib/utils';

export interface MessageImageAttachmentsProps {
  urls: string[];
  align: 'start' | 'end';
  className?: string;
}

export function MessageImageAttachments({ urls, align, className }: MessageImageAttachmentsProps) {
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);

  const slides = useMemo(
    () => urls.filter(Boolean).map((src) => ({ src })),
    [urls],
  );

  const openAt = useCallback((i: number) => {
    setIndex(i);
    setOpen(true);
  }, []);

  if (slides.length === 0) return null;

  return (
    <>
      <div
        className={cn(
          'flex flex-wrap gap-1.5',
          align === 'start' ? 'justify-start' : 'justify-end',
          className,
        )}
      >
        {slides.map((slide, i) => (
          <button
            key={`${slide.src}-${i}`}
            type="button"
            className={cn(
              'relative size-16 shrink-0 overflow-hidden rounded-lg border border-border/80 bg-muted/40',
              'ring-offset-background transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
            onClick={() => openAt(i)}
            aria-label={`View image ${i + 1} of ${slides.length}`}
          >
            <img
              src={slide.src}
              alt=""
              className="size-full object-cover"
              loading="lazy"
            />
          </button>
        ))}
      </div>
      <Lightbox
        open={open}
        close={() => setOpen(false)}
        index={index}
        slides={slides}
        on={{ view: ({ index: next }) => setIndex(next) }}
      />
    </>
  );
}
