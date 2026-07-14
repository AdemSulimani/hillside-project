/**
 * P2-2 (RC-10) — the pure sticky-locale hysteresis decision, extracted so it is unit-testable
 * without importing the heavy `aiService` (OpenAI client) module.
 */
import type { ReplyLocale } from './aiService';

/**
 * Given the conversation's sticky locale and THIS turn's unambiguous language marker (or null when
 * the turn is ambiguous), decide the reply locale. Reuse the sticky locale unless the turn carries
 * a high-confidence OPPOSITE marker — so an ambiguous turn (ok/po/yes/emoji) can never flip the
 * language, but a genuine mid-conversation switch is still honored.
 */
export function resolveStickyLocale(
  sticky: ReplyLocale,
  inboundMarker: ReplyLocale | null,
): ReplyLocale {
  return inboundMarker !== null && inboundMarker !== sticky ? inboundMarker : sticky;
}
