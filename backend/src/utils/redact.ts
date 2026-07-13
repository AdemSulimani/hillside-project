/**
 * P1-6 (SEC-5 / OBS-7, RC-01/02/03): the single PII-redaction boundary.
 *
 * The AI pipeline logs raw customer text (names, phones, addresses, health context) to stdout
 * at ~19 sites, and `ai_alerts.details` persists customer content — a GDPR exposure on an EU
 * company (Hillside L.L.C., Kosovo). There is no logger/redaction layer anywhere, so this pure
 * module is applied at every boundary where customer text leaves the canonical `messages` store:
 *
 *   - `redactPII(text)`   deterministic pattern masking (emails/phones/addresses -> stable
 *                         tokens; phone last-4 kept for support correlation). The "redacted
 *                         copy" used for durable telemetry (`ai_alerts.details`, and the future
 *                         P1-5 decision ledger's mandatory pass).
 *   - `redactValue(v)`    `redactPII` applied to every string leaf of an object/array (JSONB
 *                         blobs like `ai_alerts.details`).
 *   - `redactForLog(t)`   free-text-out reference `[pii len=N #HHHHHHHH]` (deterministic hash,
 *                         zero cleartext) — health-context-safe; the preferred form for logs.
 *
 * Every function is pure and deterministic (same input -> same output), so redacted log lines
 * stay joinable by hash without cleartext, and the `ai_alerts` backfill is safe to re-run
 * (`redactPII` is idempotent — masked tokens never re-match).
 *
 * Redaction is ON by default and gated by a single compliance flag `REDACT_PII` (set to `false`
 * to disable — a deliberate, compliance-owned action, never a casual toggle; hence the inverted
 * default vs. the repo's usual default-off feature flags).
 */
import { createHash } from 'node:crypto';
import { repairMojibake } from './textEncoding';

/**
 * Master redaction switch. ON unless `REDACT_PII` is explicitly `false`. Turning it off
 * re-exposes customer PII in logs/telemetry, so it must be a deliberate, compliance-gated
 * decision (see the boot warning in `config/validateEnv.ts`).
 */
export const REDACT_PII = (process.env.REDACT_PII ?? 'true').trim().toLowerCase() !== 'false';

/** Short, stable, non-reversible token for a matched substring (first 8 hex of sha256). */
function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

// Emails first — before phones, so any digits inside an address/email are already tokenized.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// A phone-shaped run: optional `+`, then digits and common separators, 7–15 digits total once
// separators are stripped (mirrors `isLikelyE164Phone`). The `#`/word lookbehind+lookahead keep
// it from re-matching an already-emitted `[phone#1234]` token (idempotency) or a glued SKU.
const PHONE_RE = /(?<![\w#])\+?\d[\d\s().\-]{5,}\d(?![\w#])/g;

// Best-effort Albanian/Kosovo address markers (Rruga/Rr./Lagjja/Blloku/…) plus the following
// tokens up to a separator. `rr` only counts with a trailing dot (`Rr.`) so it never fires
// mid-word. Over-redaction here is acceptable and safe; log sites don't rely on this path (they
// use `redactForLog`), so it only shapes durable telemetry.
const ADDRESS_RE = /\b(?:rruga|rr\.|lagjja|lagja|blloku|rrethi|bulevardi|bul\.)\s+[^\n,;]{1,60}/giu;

/** Mask a phone-shaped match to `[phone#<last4>]`; leave non-phone digit runs untouched. */
function maskPhone(match: string): string {
  const digits = match.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return match;
  return `[phone#${digits.slice(-4)}]`;
}

/**
 * Deterministic pattern masking of PII within a string. Emails, phone numbers (E.164 +
 * Kosovo/Albanian local forms), and address markers are replaced with stable tokens; all other
 * text (including catalog names/prices) is preserved. Repairs mojibake first so Albanian
 * address forms survive the regexes. Idempotent: re-running never changes an already-redacted
 * string.
 */
export function redactPII(text: unknown): string {
  if (text == null) return '';
  let s = typeof text === 'string' ? text : String(text);
  if (!s) return s;
  s = repairMojibake(s);
  s = s.replace(EMAIL_RE, (m) => `[email#${shortHash(m.toLowerCase())}]`);
  s = s.replace(PHONE_RE, maskPhone);
  s = s.replace(ADDRESS_RE, '[addr]');
  return s;
}

/**
 * Recursively apply `redactPII` to every string leaf of a value, preserving structure. Numbers,
 * booleans, and null pass through untouched. Use for JSONB blobs such as `ai_alerts.details`
 * and the future P1-5 ledger record.
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactPII(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Replace verbatim customer free-text with a non-reversible reference that keeps log lines
 * joinable (same text -> same hash) without exposing any content — the safest posture for
 * health context and Albanian address formats that pattern redaction can miss. Returns e.g.
 * `[pii len=42 #a1b2c3d4]`; empty/blank input returns `[pii len=0]`.
 */
export function redactForLog(text: unknown): string {
  const s = text == null ? '' : typeof text === 'string' ? text : String(text);
  const trimmed = repairMojibake(s).trim();
  if (!trimmed) return '[pii len=0]';
  return `[pii len=${trimmed.length} #${shortHash(trimmed)}]`;
}

// ---------------------------------------------------------------------------------------------
// Flag-aware wrappers — used at call sites so the compliance switch lives in one place. When
// REDACT_PII is off, each returns the original cleartext (byte-for-byte legacy behaviour).
// ---------------------------------------------------------------------------------------------

/** Verbatim customer free-text destined for a log line -> hash reference (or cleartext if off). */
export function logSafe(text: string): string {
  return REDACT_PII ? redactForLog(text) : text;
}

/**
 * Model-output dumps destined for a log line (raw LLM JSON, evaluator reasoning) -> pattern
 * masking, which preserves the surrounding structure for debugging while masking embedded PII.
 */
export function logSafeStructured(text: string): string {
  return REDACT_PII ? redactPII(text) : text;
}

/** Redact a JSONB `details` blob before it is persisted to `ai_alerts` (or the ledger). */
export function redactAlertDetails(
  details: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (details == null) return null;
  return REDACT_PII ? (redactValue(details) as Record<string, unknown>) : details;
}
