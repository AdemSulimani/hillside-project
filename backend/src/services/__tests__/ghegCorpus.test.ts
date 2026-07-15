/**
 * The Gheg corpus as a deterministic, in-CI regression suite (P2-5, RC-25/RC-10/RC-15-fluency).
 *
 * Runs the REAL routing predicates against the EV-030 corpus's discrete labels. No LLM, no
 * network, no DB — per RC-25: "Dialect classification is a discrete label — checkable without a
 * judge; reserve LLM-as-judge for fluency of the generated Albanian reply." The judge lives in
 * src/eval/ghegFluency/judge.ts and is manual, never CI.
 *
 * Every case is asserted on the Gheg-ON composition, which is what the flag turns on in
 * production. Cases that the LEGACY lexicon also passes are noted where it matters.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EV_010_CASE,
  GHEG_CORPUS,
  GHEG_CORPUS_WITH_EV_010,
} from '../../eval/ghegFluency/corpus';
import {
  GHEG_ATTRIBUTE_FOLLOW_UP_EXTRA_PATTERNS,
  GHEG_OTHER_OPTIONS_EXTRA_PATTERNS,
  GHEG_RECOMMENDATION_EXTRA_PATTERNS,
  withGhegPatterns,
} from '../ghegLexicons';
import {
  OTHER_OPTIONS_FOLLOW_UP_PATTERNS,
  isOtherOptionsFollowUp,
} from '../productRetrievalService';
import { isProductRecommendationOrComparisonQuestion } from '../productDescriptionPromptService';
import { foldDialect } from '../dialectNormalization';

const GHEG_ON_OTHER_OPTIONS = withGhegPatterns(
  OTHER_OPTIONS_FOLLOW_UP_PATTERNS,
  GHEG_OTHER_OPTIONS_EXTRA_PATTERNS,
  true,
);

/** Mirrors productRetrievalService's normalizer so attribute patterns see the same input. */
const normalize = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s?!.]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('Gheg corpus — provenance and shape', () => {
  it('carries the 17 EV-030 utterances plus the EV-010 regression', () => {
    assert.equal(GHEG_CORPUS.length, 17);
    assert.equal(GHEG_CORPUS_WITH_EV_010.length, 18);
  });

  it('every case cites its source evidence', () => {
    for (const c of GHEG_CORPUS_WITH_EV_010) {
      assert.ok(c.source.trim().length > 0, c.text);
      assert.ok(/EV-\d+/.test(c.source), `no EV reference: ${c.source}`);
    }
  });

  it('every case has a gloss (the corpus must stay readable to a non-Albanian speaker)', () => {
    for (const c of GHEG_CORPUS_WITH_EV_010) {
      assert.ok(c.gloss.trim().length > 0, c.text);
    }
  });

  it('reflects EV-030\'s defining fact: real customers type NO Albanian diacritics', () => {
    for (const c of GHEG_CORPUS) {
      assert.equal(/[ëçËÇ]/.test(c.text), false, `unexpected diacritic: ${c.text}`);
    }
  });

  it('is entirely Albanian, as real traffic is (39/40 in EV-030)', () => {
    for (const c of GHEG_CORPUS_WITH_EV_010) {
      assert.equal(c.expectLocale, 'sq', c.text);
    }
  });
});

describe('Gheg corpus — EV-010 regression', () => {
  it('routes as an other-options browsing question, so it never reaches the gap assessor', () => {
    assert.equal(EV_010_CASE.expectOtherOptions, true);
    assert.equal(isOtherOptionsFollowUp(EV_010_CASE.text, GHEG_ON_OTHER_OPTIONS), true);
  });

  it('the legacy lexicon misses it — the bug this corpus locks shut', () => {
    assert.equal(isOtherOptionsFollowUp(EV_010_CASE.text, OTHER_OPTIONS_FOLLOW_UP_PATTERNS), false);
  });
});

describe('Gheg corpus — other-options routing', () => {
  for (const c of GHEG_CORPUS_WITH_EV_010.filter((x) => x.expectOtherOptions)) {
    it(`routes as other-options: "${c.text.replace(/\n/g, ' / ')}"`, () => {
      assert.equal(isOtherOptionsFollowUp(c.text, GHEG_ON_OTHER_OPTIONS), true);
    });
  }

  it('does not over-match: a plain product question is never other-options', () => {
    for (const c of GHEG_CORPUS.filter((x) => !x.expectOtherOptions)) {
      assert.equal(
        isOtherOptionsFollowUp(c.text, GHEG_ON_OTHER_OPTIONS),
        false,
        `false positive on: ${c.text}`,
      );
    }
  });
});

describe('Gheg corpus — recommendation/comparison routing', () => {
  for (const c of GHEG_CORPUS_WITH_EV_010.filter((x) => x.expectRecommendation)) {
    it(`routes as recommendation: "${c.text}"`, () => {
      const matched =
        isProductRecommendationOrComparisonQuestion(c.text) ||
        GHEG_RECOMMENDATION_EXTRA_PATTERNS.some((re) => re.test(normalize(c.text)));
      assert.equal(matched, true);
    });
  }

  it('does not over-match: a flavour question is not a recommendation', () => {
    for (const c of GHEG_CORPUS.filter((x) => x.expectAttributeFollowUp)) {
      assert.equal(
        isProductRecommendationOrComparisonQuestion(c.text),
        false,
        `false positive on: ${c.text}`,
      );
    }
  });
});

describe('Gheg corpus — attribute follow-up routing', () => {
  for (const c of GHEG_CORPUS.filter((x) => x.expectAttributeFollowUp)) {
    it(`routes as attribute follow-up: "${c.text}"`, () => {
      // "Me qfar shije i keni" is EV-030's single most common question shape and the Gheg
      // interrogative 'qfar' is what the legacy list misses.
      assert.equal(
        GHEG_ATTRIBUTE_FOLLOW_UP_EXTRA_PATTERNS.some((re) => re.test(normalize(c.text))),
        true,
      );
    });
  }
});

describe('Gheg corpus — normalization survives the whole corpus', () => {
  it('every utterance folds without loss, throw, diacritic, or uppercase', () => {
    for (const c of GHEG_CORPUS_WITH_EV_010) {
      const folded = foldDialect(c.text);
      assert.ok(folded.length > 0, `empty fold: ${c.text}`);
      assert.equal(/[ëçËÇ]/.test(folded), false, folded);
      assert.equal(folded, folded.toLowerCase(), folded);
    }
  });

  it('folding is idempotent across the corpus', () => {
    for (const c of GHEG_CORPUS_WITH_EV_010) {
      const once = foldDialect(c.text);
      assert.equal(foldDialect(once), once, `not idempotent: ${c.text}`);
    }
  });
});
