import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePrice } from '../documents/priceParsing';

describe('parsePrice — locale-aware separators', () => {
  it('passes through plain numbers', () => {
    assert.equal(parsePrice(29.99), 29.99);
    assert.equal(parsePrice(10), 10);
    assert.equal(parsePrice(0), 0);
  });

  it('parses US decimal point', () => {
    assert.equal(parsePrice('29.99'), 29.99);
    assert.equal(parsePrice('$29.99'), 29.99);
    assert.equal(parsePrice('12.50'), 12.5);
  });

  it('parses EU decimal comma (the original bug)', () => {
    assert.equal(parsePrice('29,99'), 29.99);
    assert.equal(parsePrice('€29,99'), 29.99);
    assert.equal(parsePrice('1,5'), 1.5);
  });

  it('parses EU grouped value "1.234,56"', () => {
    assert.equal(parsePrice('1.234,56'), 1234.56);
    assert.equal(parsePrice('1.234.567,89'), 1234567.89);
  });

  it('parses US grouped value "1,234.56"', () => {
    assert.equal(parsePrice('1,234.56'), 1234.56);
    assert.equal(parsePrice('1,234,567.89'), 1234567.89);
  });

  it('treats a single comma + 3 digits as thousands', () => {
    assert.equal(parsePrice('1,500'), 1500);
    assert.equal(parsePrice('12,000'), 12000);
  });

  it('treats multiple dots as thousands separators', () => {
    assert.equal(parsePrice('1.234.567'), 1234567);
  });

  it('ignores currency symbols and whitespace', () => {
    assert.equal(parsePrice('  $ 49.95 '), 49.95);
    assert.equal(parsePrice('USD 100'), 100);
  });

  it('returns undefined for missing/non-numeric values', () => {
    assert.equal(parsePrice(''), undefined);
    assert.equal(parsePrice(null), undefined);
    assert.equal(parsePrice(undefined), undefined);
    assert.equal(parsePrice('N/A'), undefined);
    assert.equal(parsePrice('free'), undefined);
  });

  it('rejects negative and absurdly large values', () => {
    assert.equal(parsePrice(-5), undefined);
    assert.equal(parsePrice(2_000_000_000), undefined);
  });
});
