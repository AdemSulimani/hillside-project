import type { Message } from '../db/models/message';

type MessageLike = Pick<Message, 'sent_by' | 'content'>;

function normalizeLine(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function extractPhoneDigits(line: string): string | null {
  const raw = line.trim();
  const candidates = raw.match(/\+?\d[\d\s().-]{5,}\d/g) ?? [];
  const firstCandidate = candidates[0];
  if (!firstCandidate) return null;
  const digits = firstCandidate.replace(/[^\d]/g, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/**
 * Albanian and English single words that look alphabetic but are greetings,
 * affirmations, or common conversational words — never valid customer names.
 * All entries must be lowercase and diacritic-free (matching normalizeLine output).
 */
const COMMON_NON_NAME_WORDS = new Set([
  // Albanian greetings / closings / affirmations
  'pershendetje', 'mirdita', 'miremengjes', 'mirembrema', 'naten', 'natenmire',
  'faleminderit', 'falemnderit', 'faleminderit', 'flm', 'fln', 'cfn',
  'miresi', 'mirsevini', 'kenaqesi',
  'po', 'jo', 'ok', 'okej', 'dakord', 'sigurisht', 'natyrisht', 'absolutisht',
  'sakte', 'shumemire', 'shume', 'mire',
  'vazhdo', 'vazhd', 'beje', 'bej',
  // English greetings / affirmations
  'hello', 'hi', 'hey', 'thanks', 'thank', 'please', 'certainly', 'absolutely',
  'great', 'wonderful', 'perfect', 'alright', 'correct', 'exactly', 'indeed',
  'confirmed', 'understood', 'noted', 'proceed', 'continue',
]);

export function looksLikeAddressLine(line: string): boolean {
  const normalized = normalizeLine(line);
  if (!normalized) return false;

  // Explicit address-keyword prefix match (no end \b): Albanian inflected forms like
  // "rruga", "adresa", "banesat", "blloku", "prishtina" all start with the listed stems,
  // so we deliberately omit the trailing word-boundary to catch them all.
  if (
    /\b(adres|address|rrug|street|banes|bllok|prishtin|prizren|peje|gjakove|ferizaj|mitrovic)/.test(
      normalized,
    )
  ) {
    return true;
  }

  // A short number embedded in a long line strongly suggests a house/apartment number.
  if (/\b\d{1,4}\b/.test(line) && line.length >= 20) return true;

  // Comma rule: keep the original length-based heuristic BUT also require that the line
  // does NOT look like a plain "FirstName LastName, SomePlace" pattern — i.e. every
  // comma-separated segment must not be all-alphabetic words only.
  // This prevents "John Smith, London" (no digits, no address keyword) from triggering
  // while still catching "Lagja Arberia, Tirane" (city keyword "tiran" is not in the
  // stem list above, so the comma rule is needed as a final catch-all for city names
  // not in the keyword list, combined with address-structure signals).
  if (line.includes(',') && line.length >= 12) {
    // Has a digit (house/apt number) → definitely an address.
    if (/\d/.test(line)) return true;
    // Has a secondary address-structure keyword.
    if (/\b(nr|no|ap|apt|kati|kat|lagja|lagjja|zona|qyteti|qytetet|tirane|tirana)\b/.test(normalized)) return true;
    // More than two comma-separated segments — typical of full addresses (street, area, city).
    const segments = line.split(',');
    if (segments.length >= 3) return true;
  }

  return false;
}

/** Whether a line looks like a customer name (first name only, or first + last). */
export function looksLikeCustomerNameLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 80) return false;
  if (extractPhoneDigits(trimmed)) return false;
  if (looksLikeAddressLine(trimmed)) return false;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 1) return false;
  // Single-word names require at least 4 characters to avoid matching common
  // short affirmations like "yes", "mir", "ok" that slip past the length guard.
  if (parts.length === 1 && trimmed.length < 4) return false;
  // Block single-word common non-name words (greetings, affirmations, filler words).
  if (parts.length === 1 && COMMON_NON_NAME_WORDS.has(normalizeLine(trimmed))) return false;
  return parts.every((part) => /^[\p{L}'-]+$/u.test(part));
}

export function parseCustomerNameLine(
  line: string,
): { firstName: string; lastName: string } | null {
  if (!looksLikeCustomerNameLine(line)) return null;
  const parts = line.trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * Reads first + last name from customer order-detail messages (multi-line name / phone / address).
 */
export function extractCustomerNameFromMessages(
  messages: MessageLike[],
): { firstName: string | null; lastName: string | null } {
  const recent = [...messages].reverse();
  for (const msg of recent) {
    if (msg.sent_by !== 'customer') continue;
    const raw = (msg.content ?? '').trim();
    if (!raw) continue;

    const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const parsed = parseCustomerNameLine(line);
      if (parsed) return parsed;
    }
  }
  return { firstName: null, lastName: null };
}
