import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractCustomerNameFromMessages,
  looksLikeCustomerNameLine,
  parseCustomerNameLine,
} from '../orderCustomerDetails';

describe('orderCustomerDetails', () => {
  it('parses a typical multi-line Albanian order payload', () => {
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

  it('does not treat phone or address lines as names', () => {
    assert.equal(looksLikeCustomerNameLine('049778853'), false);
    assert.equal(
      looksLikeCustomerNameLine('Bregu i diellit banesat e bardha blloku 35 Prishtine'),
      false,
    );
  });

  it('parses a two-word name line directly', () => {
    assert.deepEqual(parseCustomerNameLine('Adem Sulimani'), {
      firstName: 'Adem',
      lastName: 'Sulimani',
    });
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
});
