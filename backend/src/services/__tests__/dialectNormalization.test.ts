/**
 * Tests for the shared dialect-normalization layer (P2-5, RC-25).
 *
 * The properties that matter here are the NEGATIVE ones — this layer must touch RECALL and
 * never IDENTITY. Three over-folding traps are pinned permanently:
 *   1. a bare "o" is never folded to "eshte" (EV-030 has it as both copula and vocative);
 *   2. rewrites are whole-token only (a substring 'ma'→'me' corrupts "Serious Mass");
 *   3. content words EXPAND rather than rewrite, so the catalog's own "Qokolad" stays reachable.
 * A fourth pins the delegation to `normalizeText` — the primitive calibrated against the 0.48
 * word_similarity threshold, which this module must never reimplement.
 *
 * All pure/in-process — no network/DB/OpenAI.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALBANIAN_CONTENT_VARIANTS,
  GHEG_FUNCTION_WORD_MAP,
  RETRIEVAL_STOPWORDS,
  expandDialectVariants,
  extractDialectKeywords,
  foldDialect,
} from '../dialectNormalization';
import { normalizeText } from '../productTitleNormalization';

/** EV-030: the 17 verbatim Gheg utterances from real dev traffic (appendix-A, 2026-07-12). */
const EV_030_CORPUS: readonly string[] = [
  'A munesh me ma qu foto be',
  'pershendetje a keni nitro tech ripped',
  'Sa kushton kjo shef',
  'Aha okej a muni me ma qu foto be se ju ka tek djalit tem me porosit ni qisi e spe di a osht e qasi qe pe don',
  'O shef qa bone',
  'Qysh o moti sot',
  'Adem, 045 687 266, Bregu i diellit banesat e bardha blloku 35',
  'Okej qita pe porositi pra shef',
  'Cila o ma e lira be se le qe jom cpirr po edhe fikan hahahahahah',
  'Hej a keni naj produkt tmir per shtim peshe se hiq sun po shtoj killa o shef qr',
  'Aha okej a muna shef me porosit qita me shije mjedre',
  'A keni naj kreatin',
  'Me qfar shije i keni edhe sa kushtojn',
  'Pershendetje a keni carbo one',
  'Pershendefje a keni carbo one',
  'Pershendetje a keni whey protein edhe me qfar shije',
  'Qfar shije i kan edhe sa kushtojn',
];

describe('foldDialect — delegation to the calibrated primitive', () => {
  it('is identical to normalizeText for text containing no dialect function words', () => {
    // Pins the layering: `normalizeText` is coupled to the 0.48 word_similarity calibration in
    // catalogGuardReferenceService. If anyone reimplements diacritic folding here instead of
    // delegating, this fails loudly.
    for (const text of ['Optimum Nutrition Gold Standard', 'Carbo One 1kg Orange', 'whey protein']) {
      assert.equal(foldDialect(text), normalizeText(text));
    }
  });

  it('folds diacritics exactly as normalizeText does', () => {
    assert.equal(foldDialect('çokollatë'), 'cokollate');
    assert.equal(foldDialect('Biobalancë'), 'biobalance');
  });

  it('returns empty for empty/whitespace input', () => {
    assert.equal(foldDialect(''), '');
    assert.equal(foldDialect('   '), '');
  });
});

describe('foldDialect — the over-folding traps', () => {
  it('NEVER folds a bare "o" (it is both the Gheg copula AND the vocative)', () => {
    // EV-030 contains both "Qysh o moti sot" (o = është) and "O shef qa bone" (o = "hey").
    // The remediation plan's mapping literally lists "osht/o → eshte"; the /o is wrong.
    assert.equal(foldDialect('O shef qa bone'), 'o shef cfare bone');
    assert.match(foldDialect('Qysh o moti sot'), /^si o moti sot$/);
  });

  it('rewrites whole tokens only — never substrings', () => {
    // A substring 'ma'→'me' would corrupt the catalog's own "Serious Mass".
    assert.equal(foldDialect('Serious Mass'), 'serious mass');
    assert.equal(foldDialect('Mass gainer 3kg'), 'mass gainer 3kg');
    // But the standalone Gheg comparative IS folded.
    assert.equal(foldDialect('ma shum'), 'me shum');
  });

  it('keeps singular and plural deictics distinct (never merges kjo and keto)', () => {
    assert.equal(foldDialect('qikjo'), 'kjo');
    assert.equal(foldDialect('qito'), 'keto');
    assert.equal(foldDialect('qita'), 'keto');
    assert.notEqual(foldDialect('qikjo'), foldDialect('qito'));
  });

  it('does not fold a catalog content word that shares a prefix with a function word', () => {
    // 'naj' folds; 'najlon' must not.
    assert.equal(foldDialect('najlon'), 'najlon');
  });
});

describe('foldDialect — Gheg function-word coverage', () => {
  const CASES: ReadonlyArray<[string, string]> = [
    ['A keni ma shum a veq aito', 'a keni me shum a vetem keto'],
    ['Cila osht ma e lira', 'cila eshte me e lira'],
    ['Me qfar shije i keni edhe sa kushtojn', 'me cfare shije i keni edhe sa kushtojne'],
    ['A keni naj kreatin', 'a keni ndonje kreatin'],
    ['a muna me porosit', 'a mund me porosit'],
    ['jom cpirr', 'jam cpirr'],
    ['ska ardh', 'nuk ka ardh'],
    ['produkt tmir', 'produkt te mire'],
  ];

  for (const [input, expected] of CASES) {
    it(`folds "${input}"`, () => {
      assert.equal(foldDialect(input), expected);
    });
  }

  it('folds all 17 EV-030 utterances without loss or throw', () => {
    for (const utterance of EV_030_CORPUS) {
      const folded = foldDialect(utterance);
      assert.equal(typeof folded, 'string');
      assert.ok(folded.length > 0, `empty fold for: ${utterance}`);
      // Folding must never introduce diacritics or uppercase.
      assert.equal(/[ëçËÇ]/.test(folded), false, folded);
      assert.equal(folded, folded.toLowerCase(), folded);
    }
  });

  it('every mapping value is itself already folded (no diacritics, lowercase)', () => {
    for (const [key, value] of GHEG_FUNCTION_WORD_MAP) {
      assert.equal(/[ëçËÇ]/.test(key), false, `key: ${key}`);
      assert.equal(/[ëçËÇ]/.test(value), false, `value: ${value}`);
      assert.equal(key, key.toLowerCase(), key);
    }
  });

  it('no mapping is a self-loop', () => {
    for (const [key, value] of GHEG_FUNCTION_WORD_MAP) {
      assert.notEqual(key, value, `self-loop: ${key}`);
    }
  });
});

describe('expandDialectVariants — additive, raw-first', () => {
  it('is a superset of its input and preserves input order at the front', () => {
    const input = ['qokolad', 'whey'];
    const out = expandDialectVariants(input);
    assert.deepEqual(out.slice(0, 2), input);
    for (const token of input) assert.ok(out.includes(token));
  });

  it('KEEPS the raw catalog spelling — a pure rewrite would lose the row', () => {
    // EV-031: the catalog literally holds "Vegan Protei 600gr Qokolad Karamel" and
    // "Protein 80 700gr Dubai qokolad". Rewriting 'qokolad'→'cokollate' breaks an ILIKE that
    // works today.
    const out = expandDialectVariants(['qokolad']);
    assert.ok(out.includes('qokolad'), 'raw form dropped');
    assert.ok(out.includes('cokollate'), 'variant not added');
  });

  it('never drops a token', () => {
    const input = ['carbo', 'one', 'kreatin', 'zzz'];
    const out = expandDialectVariants(input);
    for (const token of input) assert.ok(out.includes(token), token);
  });

  it('does not duplicate a variant already present', () => {
    const out = expandDialectVariants(['kreatin', 'creatine']);
    assert.equal(out.filter((t) => t === 'creatine').length, 1);
  });

  it('leaves unknown tokens untouched', () => {
    assert.deepEqual(expandDialectVariants(['nitro', 'tech']), ['nitro', 'tech']);
  });

  it('every variant key and value is folded and lowercase', () => {
    for (const [key, variants] of ALBANIAN_CONTENT_VARIANTS) {
      assert.equal(/[ëçËÇ]/.test(key), false, key);
      assert.equal(key, key.toLowerCase(), key);
      for (const v of variants) {
        assert.equal(/[ëçËÇ]/.test(v), false, v);
        assert.equal(v, v.toLowerCase(), v);
        assert.notEqual(v, key, `variant equals its own key: ${key}`);
      }
    }
  });
});

describe('extractDialectKeywords — the unified lexical pipeline', () => {
  it('drops Gheg function words that today become garbage ILIKE terms', () => {
    // "Me qfar shije i keni edhe sa kushtojn" yields 'qfar', 'shije', 'kushtojn' today — and
    // %shije% substring-matches 46 of 257 products by name (EV-011/WF-E).
    const out = extractDialectKeywords('Me qfar shije i keni edhe sa kushtojn');
    assert.equal(out.includes('qfar'), false, 'qfar survived');
    assert.equal(out.includes('cfare'), false, 'cfare survived (stopworded)');
    assert.equal(out.includes('kushtojn'), false, 'kushtojn survived');
    assert.equal(out.includes('kushtojne'), false, 'kushtojne survived');
  });

  it('keeps genuine product tokens', () => {
    const out = extractDialectKeywords('pershendetje a keni nitro tech ripped');
    assert.ok(out.includes('nitro'));
    assert.ok(out.includes('tech'));
    assert.ok(out.includes('ripped'));
  });

  it('folds a diacritic query onto the diacritic-free catalog spelling', () => {
    // This is the arm disagreement: the keyword path used to search %çokollatë%.
    const out = extractDialectKeywords('a keni çokollatë');
    assert.ok(out.includes('cokollate'));
    assert.equal(out.some((t) => /[ëç]/.test(t)), false);
  });

  it('drops the Gheg vocatives and slang that dilute the product signal', () => {
    const out = extractDialectKeywords('Hej a keni naj produkt tmir per shtim peshe se hiq sun po shtoj killa o shef qr');
    for (const noise of ['shef', 'naj', 'ndonje', 'sun', 'smund', 'produkt']) {
      assert.equal(out.includes(noise), false, `noise survived: ${noise}`);
    }
    assert.ok(out.includes('peshe'), 'lost the category signal');
  });

  it('returns [] for a message with no content words', () => {
    assert.deepEqual(extractDialectKeywords('O shef'), []);
  });

  it('never emits a token of length <= 2', () => {
    for (const utterance of EV_030_CORPUS) {
      for (const token of extractDialectKeywords(utterance)) {
        assert.ok(token.length > 2, `short token "${token}" from: ${utterance}`);
      }
    }
  });
});

describe('RETRIEVAL_STOPWORDS — the single unified list', () => {
  it('every entry is folded and lowercase (callers fold before lookup)', () => {
    for (const word of RETRIEVAL_STOPWORDS) {
      assert.equal(/[ëçËÇ]/.test(word), false, word);
      assert.equal(word, word.toLowerCase(), word);
    }
  });

  it('covers the union of the two legacy copies that had drifted apart', () => {
    // aiService's list had these; productRetrievalService's shadow copy did not.
    for (const word of ['shume', 'mire', 'fare', 'mund', 'nuk', 'tani', 'faleminderit']) {
      assert.ok(RETRIEVAL_STOPWORDS.has(word), `missing from aiService's side: ${word}`);
    }
    // productRetrievalService's copy had these; aiService's did not.
    for (const word of ['produkt', 'produkte']) {
      assert.ok(RETRIEVAL_STOPWORDS.has(word), `missing from productRetrieval's side: ${word}`);
    }
  });

  it('covers the Gheg function words that dominate real traffic (EV-030)', () => {
    for (const word of ['qfar', 'veq', 'qysh', 'naj', 'osht', 'ska', 'shef', 'kushtojn']) {
      assert.ok(RETRIEVAL_STOPWORDS.has(word), `missing Gheg stopword: ${word}`);
    }
  });

  it('does not stopword a genuine catalog content word', () => {
    for (const word of ['shije', 'kreatin', 'proteina', 'whey', 'peshe', 'qokolad']) {
      assert.equal(RETRIEVAL_STOPWORDS.has(word), false, `content word stopworded: ${word}`);
    }
  });
});
