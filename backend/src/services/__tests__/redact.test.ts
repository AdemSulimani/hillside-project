/**
 * Tests for P1-6 (SEC-5 / OBS-7) — the PII redaction boundary (`utils/redact.ts`).
 *
 * All pure/in-process (no DB/Redis/network). Covers Albanian/Kosovo/international phone forms,
 * emails, address markers, mojibake-corrupted input, determinism, idempotency (so the backfill
 * is safe to re-run), the recursive `redactValue`, the free-text-out `redactForLog` reference,
 * and the flag-aware wrappers in their default (ON) state.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  redactPII,
  redactValue,
  redactForLog,
  logSafe,
  logSafeStructured,
  redactAlertDetails,
} from '../../utils/redact';

const LOG_REF_RE = /^\[pii len=\d+ #[0-9a-f]{8}\]$/;

describe('redactPII — phones (Kosovo / Albania / international)', () => {
  const cases: Array<[string, string]> = [
    ['+383 44 123 456', '[phone#3456]'], // Kosovo, E.164
    ['044123456', '[phone#3456]'], // Kosovo, local, no separators
    ['049 123 123', '[phone#3123]'], // Kosovo, local, spaced
    ['+355 69 123 4567', '[phone#4567]'], // Albania, E.164
    ['069 123 4567', '[phone#4567]'], // Albania, local
    ['+1 415 555 2671', '[phone#2671]'], // generic international
  ];
  for (const [input, expected] of cases) {
    it(`masks ${input} -> ${expected}`, () => {
      assert.equal(redactPII(input), expected);
    });
  }

  it('masks a phone embedded in Albanian free text without touching the rest', () => {
    const out = redactPII('Më merr në 044 123 456 pas ore 5');
    assert.equal(out, 'Më merr në [phone#3456] pas ore 5');
    assert.ok(!/\d{3}\s?\d{3}/.test(out), 'no 6-digit run should survive');
  });

  it('keeps the last 4 digits for support correlation', () => {
    assert.ok(redactPII('044 999 888').endsWith('9888]'));
  });

  it('does not mask short numbers like prices', () => {
    assert.equal(redactPII('Çmimi 19.99 €'), 'Çmimi 19.99 €');
  });
});

describe('redactPII — emails', () => {
  it('masks an email and preserves surrounding text', () => {
    const out = redactPII('me kontakto agron@example.com faleminderit');
    assert.ok(out.startsWith('me kontakto [email#'));
    assert.ok(out.endsWith('] faleminderit'));
    assert.ok(!out.includes('agron@example.com'));
  });

  it('is case-insensitive and deterministic (same email -> same token)', () => {
    assert.equal(redactPII('Agron@Example.com'), redactPII('agron@example.com'));
  });
});

describe('redactPII — Albanian address markers', () => {
  it('masks "Rruga …" up to the next separator', () => {
    const out = redactPII('Rruga Agim Ramadani 12, Prishtinë');
    assert.equal(out, '[addr], Prishtinë');
    assert.ok(!out.includes('Agim Ramadani'));
  });

  it('masks the abbreviated "Rr." form', () => {
    assert.equal(redactPII('Rr. Nëna Terezë 5'), '[addr]');
  });

  it('does not fire on "rr" mid-word', () => {
    assert.equal(redactPII('arriti shpejt'), 'arriti shpejt');
  });
});

describe('redactPII — determinism, idempotency, mojibake', () => {
  const mixed = 'Rruga Agim Ramadani 12, agron@example.com, +383 44 123 456';

  it('is deterministic (same input -> identical output)', () => {
    assert.equal(redactPII(mixed), redactPII(mixed));
  });

  it('is idempotent (re-redaction never changes an already-redacted string)', () => {
    const once = redactPII(mixed);
    assert.equal(redactPII(once), once);
    assert.ok(once.includes('[addr]') && once.includes('[email#') && once.includes('[phone#3456]'));
  });

  it('repairs mojibake first, then masks (address + phone)', () => {
    const out = redactPII('Rruga NÃ«na TerezÃ« 12, +383 44 111 222');
    assert.ok(out.includes('[addr]'), 'address masked');
    assert.ok(out.includes('[phone#1222]'), 'phone masked');
    assert.ok(!out.includes('Ã'), 'no mojibake marker survives');
    assert.ok(!out.includes('111 222'), 'no raw phone digits survive');
  });

  it('handles null/undefined/empty defensively', () => {
    assert.equal(redactPII(null), '');
    assert.equal(redactPII(undefined), '');
    assert.equal(redactPII(''), '');
  });
});

describe('redactValue — recursive over JSONB blobs', () => {
  it('masks string leaves and leaves numbers / non-PII strings intact', () => {
    const out = redactValue({
      customer_question: 'Më merr në 044 123 456',
      catalogPrices: [19.99, 24.5],
      product_name: 'BSN Syntha-6',
      nested: { note: 'thirr 069 123 4567' },
    }) as Record<string, unknown>;

    assert.equal(out.customer_question, 'Më merr në [phone#3456]');
    assert.deepEqual(out.catalogPrices, [19.99, 24.5]);
    assert.equal(out.product_name, 'BSN Syntha-6');
    assert.equal((out.nested as Record<string, unknown>).note, 'thirr [phone#4567]');
  });

  it('passes non-object primitives straight through', () => {
    assert.equal(redactValue(42), 42);
    assert.equal(redactValue(true), true);
    assert.equal(redactValue(null), null);
  });
});

describe('redactForLog — free-text-out reference', () => {
  it('returns a hash reference with no cleartext (health-context safe)', () => {
    const out = redactForLog('kam diabet dhe presion të lartë');
    assert.ok(LOG_REF_RE.test(out), `expected a [pii len=N #hash] reference, got ${out}`);
    assert.ok(!out.includes('diabet'));
  });

  it('is deterministic (same text -> same reference), joinable across log lines', () => {
    assert.equal(redactForLog('044 123 456'), redactForLog('044 123 456'));
  });

  it('collapses empty / blank input to a stable zero marker', () => {
    assert.equal(redactForLog(''), '[pii len=0]');
    assert.equal(redactForLog('   '), '[pii len=0]');
    assert.equal(redactForLog(null), '[pii len=0]');
  });
});

describe('flag wrappers (default ON)', () => {
  it('logSafe emits a hash reference for verbatim customer text', () => {
    assert.ok(LOG_REF_RE.test(logSafe('044 123 456')));
  });

  it('logSafeStructured masks PII but keeps structure for debugging', () => {
    const out = logSafeStructured('{"delivery_address":"Rruga X 5","phone":"044123456"}');
    assert.ok(out.includes('"delivery_address"'), 'JSON key preserved');
    assert.ok(out.includes('[phone#3456]'), 'phone masked');
    assert.ok(!out.includes('044123456'), 'no raw phone survives');
  });

  it('redactAlertDetails masks a details blob and passes null through', () => {
    const out = redactAlertDetails({ customer_question: '044 123 456' });
    assert.deepEqual(out, { customer_question: '[phone#3456]' });
    assert.equal(redactAlertDetails(null), null);
  });
});
