import { lazy, type ComponentType } from 'react';

/**
 * Wraps `React.lazy` so that a failed dynamic import (almost always caused by a deploy
 * having generated new bundle hashes while the user had a stale tab open) triggers a
 * one-shot full page reload instead of crashing the route.
 *
 * Why a one-shot:
 *  - On real network failures we don't want an infinite reload loop.
 *  - We mark the attempt in `sessionStorage` so a second consecutive failure for the
 *    same module surfaces as a normal error (caught by the ErrorBoundary).
 *  - The flag clears on successful load so the next deploy works the same way.
 */
const RELOAD_FLAG_PREFIX = 'lazy-retry:';

function reloadFlagKey(name: string): string {
  return `${RELOAD_FLAG_PREFIX}${name}`;
}

function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message || '';
  return (
    /Failed to fetch dynamically imported module/i.test(message) ||
    /Importing a module script failed/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /ChunkLoadError/i.test(error.name)
  );
}

export function lazyWithRetry<T extends ComponentType<unknown>>(
  importer: () => Promise<{ default: T }>,
  name: string,
): ReturnType<typeof lazy<T>> {
  return lazy(async () => {
    const flag = reloadFlagKey(name);

    try {
      const mod = await importer();
      sessionStorage.removeItem(flag);
      return mod;
    } catch (err) {
      if (isChunkLoadError(err)) {
        const alreadyTried = sessionStorage.getItem(flag) === '1';
        if (!alreadyTried) {
          sessionStorage.setItem(flag, '1');
          window.location.reload();
          return new Promise(() => {});
        }
      }
      throw err;
    }
  });
}
