import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractBaseName,
  tokenizeForMatch,
  parseProductTitle,
  extractSelectionAttributes,
  attributeOverlapScore,
  rankProductsByAttributeOverlap,
  hasAnyAttribute,
  type AttributeRankable,
} from '../productTitleNormalization';

describe('extractBaseName', () => {
  it('strips serving counts from the title', () => {
    assert.equal(extractBaseName('Creatine Monohydrate 50 Servings'), 'Creatine Monohydrate');
    assert.equal(extractBaseName('Creatine Monohydrate 100 Servings'), 'Creatine Monohydrate');
  });

  it('strips flavor and size tokens', () => {
    const base = extractBaseName('Strawberry Whey Protein 2kg');
    assert.ok(!/strawberry/i.test(base));
    assert.ok(!/2kg/i.test(base));
    assert.match(base, /Whey Protein/i);
  });

  it('strips parentheticals and separators', () => {
    const base = extractBaseName('Mass Gainer Pro (New Label) - Chocolate, 2kg');
    assert.ok(!/chocolate/i.test(base));
    assert.ok(!/2kg/i.test(base));
    assert.match(base, /Mass Gainer Pro/i);
  });

  it('handles unit synonyms (scoops, caps, lbs)', () => {
    assert.match(extractBaseName('BCAA 60 caps'), /BCAA/i);
    assert.ok(!/caps/i.test(extractBaseName('BCAA 60 caps')));
    assert.ok(!/lbs/i.test(extractBaseName('Whey Gold 5 lbs')));
  });

  it('falls back to a slice when stripping leaves too little', () => {
    // Entire name is an attribute; we must not return an empty base.
    const base = extractBaseName('2kg');
    assert.ok(base.length > 0);
  });
});

describe('tokenizeForMatch', () => {
  it('drops stopwords, punctuation, single chars and bare numbers', () => {
    assert.deepEqual(tokenizeForMatch('Creatine Monohydrate 50 Servings'), [
      'creatine',
      'monohydrate',
      'servings',
    ]);
  });

  it('keeps alphanumeric identity tokens like b6 / q10 / bcaa', () => {
    assert.deepEqual(tokenizeForMatch('Vitamin B6 Q10 BCAA'), ['vitamin', 'b6', 'q10', 'bcaa']);
  });

  it('deduplicates and lowercases', () => {
    assert.deepEqual(tokenizeForMatch('Whey WHEY whey'), ['whey']);
  });
});

describe('parseProductTitle', () => {
  it('separates base identity tokens from variant attributes', () => {
    const parsed = parseProductTitle('Creatine Monohydrate 50 Servings');
    assert.equal(parsed.baseName, 'Creatine Monohydrate');
    assert.deepEqual(parsed.baseTokens, ['creatine', 'monohydrate']);
    assert.deepEqual(parsed.attributes.sizeSignatures, ['50serving']);
  });

  it('parses flavor + size from a fully attributed title', () => {
    const parsed = parseProductTitle('Strawberry Whey Protein 2kg');
    assert.deepEqual(parsed.baseTokens, ['whey', 'protein']);
    assert.deepEqual(parsed.attributes.flavors, ['strawberry']);
    assert.deepEqual(parsed.attributes.sizeSignatures, ['2kg']);
  });
});

describe('attributeOverlapScore', () => {
  it('scores an exact size signature match highest', () => {
    const q = extractSelectionAttributes('50 servings');
    const a = extractSelectionAttributes('Creatine 50 Servings');
    const b = extractSelectionAttributes('Creatine 100 Servings');
    assert.ok(attributeOverlapScore(q, a) > attributeOverlapScore(q, b));
  });

  it('matches a bare number against a candidate size signature (weak signal)', () => {
    const q = extractSelectionAttributes('the 60 one');
    const a = extractSelectionAttributes('Creatine 60 Servings');
    assert.ok(attributeOverlapScore(q, a) > 0);
  });

  it('reports no attributes for a plain base query', () => {
    assert.equal(hasAnyAttribute(extractSelectionAttributes('creatine monohydrate')), false);
  });
});

describe('rankProductsByAttributeOverlap', () => {
  const products: AttributeRankable[] = [
    { name: 'Creatine Monohydrate 100 Servings' },
    { name: 'Creatine Monohydrate 50 Servings' },
    { name: 'Creatine Monohydrate 30 Servings' },
  ];

  it('floats the variant whose servings the photo shows to the top', () => {
    const ranked = rankProductsByAttributeOverlap(
      products,
      extractSelectionAttributes('creatine monohydrate 50 servings'),
    );
    assert.equal(ranked[0].name, 'Creatine Monohydrate 50 Servings');
  });

  it('uses the structured flavor column, not just the title', () => {
    const flavored: AttributeRankable[] = [
      { name: 'Mass Gainer', flavor: 'Chocolate' },
      { name: 'Mass Gainer', flavor: 'Vanilla' },
    ];
    const ranked = rankProductsByAttributeOverlap(
      flavored,
      extractSelectionAttributes('the vanilla one'),
    );
    assert.equal(ranked[0].flavor, 'Vanilla');
  });

  it('preserves input order when the query carries no attributes', () => {
    const ranked = rankProductsByAttributeOverlap(
      products,
      extractSelectionAttributes('creatine monohydrate'),
    );
    assert.deepEqual(
      ranked.map((p) => p.name),
      products.map((p) => p.name),
    );
  });

  it('keeps relative order on ties (stable)', () => {
    const ranked = rankProductsByAttributeOverlap(
      [
        { name: 'Creatine Monohydrate 100 Servings' },
        { name: 'Creatine Monohydrate 30 Servings' },
      ],
      extractSelectionAttributes('creatine 50 servings'),
    );
    // Neither matches "50"; order must be preserved.
    assert.equal(ranked[0].name, 'Creatine Monohydrate 100 Servings');
  });
});
