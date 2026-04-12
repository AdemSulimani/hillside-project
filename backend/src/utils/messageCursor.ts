import type { Message } from '../db/models/message';

const CURSOR_PREFIX = 'm1:';

export function encodeMessageCursor(message: Pick<Message, 'created_at' | 'id'>): string {
  const createdAt =
    message.created_at instanceof Date ? message.created_at.toISOString() : String(message.created_at);
  const payload = JSON.stringify({ t: createdAt, id: message.id });
  return CURSOR_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

export type DecodedMessageCursor =
  | { kind: 'tuple'; createdAt: Date; id: string }
  | { kind: 'legacy_before'; createdAt: Date };

/**
 * Parses cursor from query string: composite `m1:base64url(JSON)` or legacy ISO-8601 `before` value.
 */
export function decodeMessageCursor(raw: string | undefined): DecodedMessageCursor | null {
  if (raw === undefined || raw.trim() === '') {
    return null;
  }

  const s = raw.trim();

  if (s.startsWith(CURSOR_PREFIX)) {
    const b64 = s.slice(CURSOR_PREFIX.length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      't' in parsed &&
      'id' in parsed &&
      typeof (parsed as { t: unknown }).t === 'string' &&
      typeof (parsed as { id: unknown }).id === 'string'
    ) {
      const createdAt = new Date((parsed as { t: string }).t);
      if (Number.isNaN(createdAt.getTime())) {
        return null;
      }
      return { kind: 'tuple', createdAt, id: (parsed as { id: string }).id };
    }
    return null;
  }

  const createdAt = new Date(s);
  if (Number.isNaN(createdAt.getTime())) {
    return null;
  }
  return { kind: 'legacy_before', createdAt };
}
