import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isProductRecommendationOrComparisonQuestion } from '../productDescriptionPromptService';

describe('isProductRecommendationOrComparisonQuestion — price-ranking / comparison detection', () => {
  it('detects standard Tosk Albanian superlatives', () => {
    assert.equal(isProductRecommendationOrComparisonQuestion('cila është më e lira?'), true);
    assert.equal(isProductRecommendationOrComparisonQuestion('cili është më i shtrenjtë?'), true);
  });

  it('detects Gheg/dialect forms ("ma" = "më", feminine "lira")', () => {
    // This is the exact phrasing from the reported bug: "which is the cheapest".
    assert.equal(isProductRecommendationOrComparisonQuestion('Cila osht ma e lira'), true);
    assert.equal(isProductRecommendationOrComparisonQuestion('ma i liri'), true);
    assert.equal(isProductRecommendationOrComparisonQuestion('cila osht ma e shtrejt'), true);
    assert.equal(isProductRecommendationOrComparisonQuestion('ma e mira'), true);
  });

  it('detects English comparison / recommendation questions', () => {
    assert.equal(isProductRecommendationOrComparisonQuestion('which is the cheapest?'), true);
    assert.equal(isProductRecommendationOrComparisonQuestion('which would you recommend?'), true);
    assert.equal(isProductRecommendationOrComparisonQuestion('compare the prices'), true);
  });

  it('does not fire on a plain single-product price question', () => {
    assert.equal(isProductRecommendationOrComparisonQuestion('Sa kushton Critical Mass?'), false);
    assert.equal(isProductRecommendationOrComparisonQuestion('do you have this in stock?'), false);
  });
});
