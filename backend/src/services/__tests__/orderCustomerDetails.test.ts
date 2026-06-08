import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCustomerNameFromMessages,
  looksLikeCustomerNameLine,
  looksLikeAddressLine,
  parseCustomerNameLine,
} from '../orderCustomerDetails';

describe('orderCustomerDetails', () => {
  // ---- looksLikeCustomerNameLine -----------------------------------------------

  it('accepts a two-word Albanian name', () => {
    assert.equal(looksLikeCustomerNameLine('adem sulimani'), true);
  });

  it('accepts a single-word first name (4+ chars)', () => {
    assert.equal(looksLikeCustomerNameLine('Arben'), true);
    assert.equal(looksLikeCustomerNameLine('Rina'), true);
  });

  it('rejects single-word names shorter than 4 chars', () => {
    assert.equal(looksLikeCustomerNameLine('yes'), false);
    assert.equal(looksLikeCustomerNameLine('ok'), false);
    assert.equal(looksLikeCustomerNameLine('po'), false);
  });

  it('rejects common Albanian greetings that look like names', () => {
    assert.equal(looksLikeCustomerNameLine('Mirdita'), false);
    assert.equal(looksLikeCustomerNameLine('Pershendetje'), false);
    assert.equal(looksLikeCustomerNameLine('Faleminderit'), false);
  });

  it('rejects common English greetings and affirmations', () => {
    assert.equal(looksLikeCustomerNameLine('Hello'), false);
    assert.equal(looksLikeCustomerNameLine('Thanks'), false);
    assert.equal(looksLikeCustomerNameLine('Perfect'), false);
    assert.equal(looksLikeCustomerNameLine('Confirmed'), false);
  });

  it('does not treat phone or address lines as names', () => {
    assert.equal(looksLikeCustomerNameLine('049778853'), false);
    assert.equal(
      looksLikeCustomerNameLine('Bregu i diellit banesat e bardha blloku 35 Prishtine'),
      false,
    );
  });

  // ---- looksLikeAddressLine ----------------------------------------------------

  it('identifies explicit address-keyword lines as addresses', () => {
    assert.equal(looksLikeAddressLine('Rruga Fehmi Agani, Prishtine'), true);
    assert.equal(looksLikeAddressLine('Blloku 5, Prishtine'), true);
    assert.equal(looksLikeAddressLine('Adresa ime eshte Peje'), true);
  });

  it('identifies comma+number lines as addresses', () => {
    assert.equal(looksLikeAddressLine('Lagja Arberia, Ap. 5, Tirane'), true);
    assert.equal(looksLikeAddressLine('Zona Industriale, Nr 12, Fushe Kosove'), true);
  });

  it('does NOT classify a plain name+city (no number, no keyword) as an address', () => {
    // "Arben Krasniqi, Mitrovice" — "Mitrovice" contains "mitrovic" keyword so IS an address
    // but "Arben Krasniqi, London" should NOT be classified as an address by the comma rule
    assert.equal(looksLikeAddressLine('Arben Krasniqi, London'), false);
  });

  it('still identifies city-keyword lines as addresses', () => {
    // "Prishtine" alone is an address keyword
    assert.equal(looksLikeAddressLine('Lagja Kalabria, Prishtine'), true);
  });

  // ---- parseCustomerNameLine ---------------------------------------------------

  it('parses a two-word name line', () => {
    assert.deepEqual(parseCustomerNameLine('Adem Sulimani'), {
      firstName: 'Adem',
      lastName: 'Sulimani',
    });
  });

  it('parses a single-word first name (no last name)', () => {
    assert.deepEqual(parseCustomerNameLine('Arben'), {
      firstName: 'Arben',
      lastName: '',
    });
  });

  it('returns null for a phone line', () => {
    assert.equal(parseCustomerNameLine('049778853'), null);
  });

  it('returns null for common Albanian greetings', () => {
    assert.equal(parseCustomerNameLine('Mirdita'), null);
    assert.equal(parseCustomerNameLine('Faleminderit'), null);
  });

  // ---- extractCustomerNameFromMessages -----------------------------------------

  it('parses a typical multi-line Albanian order payload (first + last name)', () => {
    const messages = [
      {
        sent_by: 'customer' as const,
        content:
          'adem sulimani\n049778853\nBregu i diellit banesat e bardha blloku 35 Prishtine',
      },
    ];
    assert.deepEqual(extractCustomerNameFromMessages(messages), {
      firstName: 'adem',
      lastName: 'sulimani',
    });
  });

  it('parses a first-name-only multi-line order payload', () => {
    const messages = [
      {
        sent_by: 'customer' as const,
        content: 'Arben\n049778853\nRruga Fehmi Agani, Prishtine',
      },
    ];
    const result = extractCustomerNameFromMessages(messages);
    assert.equal(result.firstName, 'Arben');
    assert.equal(result.lastName, '');
  });

  it('uses the latest customer order-details message', () => {
    const messages = [
      { sent_by: 'customer' as const, content: 'hello' },
      { sent_by: 'ai' as const, content: 'Please share your details' },
      {
        sent_by: 'customer' as const,
        content: 'John Smith\n+441234567890\n12 Baker Street, London',
      },
    ];
    assert.deepEqual(extractCustomerNameFromMessages(messages), {
      firstName: 'John',
      lastName: 'Smith',
    });
  });

  it('returns null when no name line is present (phone + address only)', () => {
    const messages = [
      { sent_by: 'customer' as const, content: '049778853\nRruga Agani 5, Prizren' },
    ];
    assert.deepEqual(extractCustomerNameFromMessages(messages), {
      firstName: null,
      lastName: null,
    });
  });

  it('ignores AI messages when looking for a name', () => {
    const messages = [
      { sent_by: 'ai' as const, content: 'John Doe\nSome address content' },
      { sent_by: 'customer' as const, content: '049123456\nRruga Fehmi Agani nr 12, Prishtine' },
    ];
    assert.deepEqual(extractCustomerNameFromMessages(messages), {
      firstName: null,
      lastName: null,
    });
  });

  it('does not extract a city name (e.g. Prishtina as first line) as a customer name', () => {
    // Edge case: customer sends city\nphone\naddress — city should NOT be the name.
    const messages = [
      {
        sent_by: 'customer' as const,
        content: 'Prishtina\n049778853\nRruga Agani Nr 5',
      },
    ];
    assert.deepEqual(extractCustomerNameFromMessages(messages), {
      firstName: null,
      lastName: null,
    });
  });

  it('does not extract an Albanian greeting before the order details as the name', () => {
    const messages = [
      { sent_by: 'customer' as const, content: 'Mirdita' },
      { sent_by: 'ai' as const, content: 'Mirë se vini! Si mund t\'ju ndihmoj?' },
      { sent_by: 'customer' as const, content: '049778853\nRruga Agani 5, Prizren' },
    ];
    // "Mirdita" from the first customer message must NOT be returned as the name.
    assert.deepEqual(extractCustomerNameFromMessages(messages), {
      firstName: null,
      lastName: null,
    });
  });
});
