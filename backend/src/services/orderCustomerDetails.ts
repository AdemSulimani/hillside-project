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

function looksLikeAddressLine(line: string): boolean {
  const normalized = normalizeLine(line);
  if (!normalized) return false;
  return (
    /\b(adres|address|rrug|street|banes|bllok|prishtin|prizren|peje|gjakove|ferizaj|mitrovic)\b/.test(
      normalized,
    ) ||
    (line.includes(',') && line.length >= 12) ||
    (/\b\d{1,4}\b/.test(line) && line.length >= 20)
  );
}

/** Whether a line looks like a customer full name (not phone/address). */
export function looksLikeCustomerNameLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 80) return false;
  if (extractPhoneDigits(trimmed)) return false;
  if (looksLikeAddressLine(trimmed)) return false;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return false;
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
