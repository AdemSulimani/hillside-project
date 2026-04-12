import { type RefObject, useEffect, useRef } from 'react';

export type UseIntersectionObserverOptions = {
  /** Scroll root; omit for viewport */
  root?: RefObject<Element | null> | null;
  rootMargin?: string;
  threshold?: number | number[];
  /** When false, the observer is not attached */
  enabled?: boolean;
  /** When this value changes, the observer is rebound (e.g. after async mount of the target). */
  reobserveKey?: unknown;
};

/**
 * Invokes `onIntersect` when the target element intersects the root (or viewport).
 */
export function useIntersectionObserver(
  targetRef: RefObject<Element | null>,
  onIntersect: () => void,
  options: UseIntersectionObserverOptions = {},
): void {
  const {
    root: rootRef = null,
    rootMargin = '0px',
    threshold = 0,
    enabled = true,
    reobserveKey,
  } = options;

  const onIntersectRef = useRef(onIntersect);
  onIntersectRef.current = onIntersect;

  useEffect(() => {
    if (!enabled) return;
    const el = targetRef.current;
    if (!el) return;

    const rootEl = rootRef?.current ?? undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          onIntersectRef.current();
        }
      },
      { root: rootEl, rootMargin, threshold },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, targetRef, rootRef, rootMargin, threshold, reobserveKey]);
}
