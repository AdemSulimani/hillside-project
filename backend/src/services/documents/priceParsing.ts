/**
 * Locale-aware price parsing shared by every catalog ingestion path
 * (spreadsheet, PDF, OCR image, and AI enrichment).
 *
 * Why this exists: the previous per-parser logic stripped every character except
 * digits and a dot (`replace(/[^0-9.]/g, '')`). That turned the European decimal
 * comma "29,99" into "2999" (€2999 instead of €29.99) and mangled grouped values
 * like "1.234,56". Wrong prices feed straight into the AI's catalog context, so the
 * assistant quotes prices that do not exist. This module normalises the common
 * thousand/decimal-separator conventions before parsing.
 *
 * Conventions handled:
 *   "29,99"        -> 29.99   (EU decimal comma)
 *   "1.234,56"     -> 1234.56 (EU grouped)
 *   "1,234.56"     -> 1234.56 (US grouped)
 *   "1,500"        -> 1500    (single comma + 3 digits = thousands)
 *   "1.234.567"    -> 1234567 (multiple dots = thousands)
 *   "$29.99"/"€10" -> 29.99 / 10 (currency symbols ignored)
 *   29.99 (number) -> 29.99
 */

/**
 * Absurdly-large values are almost always a separator/parse artifact rather than a
 * real catalog price, so we reject them instead of storing a corrupt figure. Kept
 * generous (1e9) so genuine high-ticket items are never dropped.
 */
const MAX_REASONABLE_PRICE = 1_000_000_000;

/**
 * Parse a price from a spreadsheet cell, OCR token, or AI-extracted string/number.
 * Returns `undefined` when the value is missing, non-numeric, negative, or beyond the
 * sanity ceiling — callers decide how to handle the absence.
 */
export function parsePrice(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 && value <= MAX_REASONABLE_PRICE
      ? value
      : undefined;
  }

  if (typeof value !== 'string') return undefined;

  // Keep digits and separators only (drops currency symbols, spaces, letters). A
  // leading minus is intentionally dropped — prices are never negative.
  const cleaned = value.replace(/[^\d.,]/g, '');
  if (!cleaned) return undefined;

  const normalized = normalizeSeparators(cleaned);
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > MAX_REASONABLE_PRICE) {
    return undefined;
  }
  return parsed;
}

/**
 * Normalise thousand/decimal separators in a string that already contains only
 * digits, dots, and commas, returning a canonical `1234.56` form.
 */
function normalizeSeparators(s: string): string {
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');

  if (hasComma && hasDot) {
    // Whichever separator appears LAST is the decimal separator; the other groups
    // thousands and is removed.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      return s.replace(/\./g, '').replace(',', '.');
    }
    return s.replace(/,/g, '');
  }

  if (hasComma) {
    const parts = s.split(',');
    // Single comma followed by 1–2 digits => decimal comma ("29,99"). A single comma
    // followed by exactly 3 digits ("1,500") or multiple commas ("1,234,567") are
    // thousands separators and are stripped.
    if (parts.length === 2 && parts[1].length > 0 && parts[1].length <= 2) {
      return s.replace(',', '.');
    }
    return s.replace(/,/g, '');
  }

  if (hasDot) {
    const parts = s.split('.');
    // Multiple dots ("1.234.567") are unambiguously thousands separators.
    if (parts.length > 2) {
      return s.replace(/\./g, '');
    }
    // A single dot is treated as the decimal point (standard "12.99"); no change.
  }

  return s;
}
