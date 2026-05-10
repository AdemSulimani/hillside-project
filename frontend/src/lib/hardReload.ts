/** Session key: ErrorBoundary one-shot auto-reload (must survive `clearPerRouteLazyRetryFlags`). */
export const LAZY_RETRY_ERROR_BOUNDARY_FLAG = 'lazy-retry:__error_boundary__';

/** Clears per-route lazy retry markers; keeps the ErrorBoundary one-shot flag so we cannot reload-loop. */
export function clearPerRouteLazyRetryFlags(): void {
  for (let i = sessionStorage.length - 1; i >= 0; i--) {
    const k = sessionStorage.key(i);
    if (k?.startsWith('lazy-retry:') && k !== LAZY_RETRY_ERROR_BOUNDARY_FLAG) {
      sessionStorage.removeItem(k);
    }
  }
}

export type HardReloadSpaOptions = {
  /** User clicked "Refresh" — allow one more automatic chunk-retry after this navigation. */
  clearErrorBoundaryFlag?: boolean;
};

/**
 * Forces the browser to fetch a fresh document (and thus a fresh index.html with
 * up-to-date Vite chunk hashes) after a deploy. Plain `location.reload()` can still
 * serve a stale cached shell; a new URL with a one-off query param busts that cache.
 */
export function hardReloadSpa(options?: HardReloadSpaOptions): void {
  clearPerRouteLazyRetryFlags();
  if (options?.clearErrorBoundaryFlag) {
    sessionStorage.removeItem(LAZY_RETRY_ERROR_BOUNDARY_FLAG);
  }
  const { origin, pathname, search } = window.location;
  const sep = search && search !== '' ? '&' : '?';
  window.location.replace(`${origin}${pathname}${search}${sep}_app_reload=${Date.now()}`);
}
