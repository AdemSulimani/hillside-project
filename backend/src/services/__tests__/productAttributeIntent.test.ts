import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAttributeIntentFromKeywords,
  detectImplicitAttributeSelection,
  hasProductKnowledgeKeywordCue,
  isAttributeQuestionMessage,
} from '../productAttributeIntentHeuristics';

describe('productAttributeIntentService', () => {
  it('detects category attribute follow-ups without LLM', () => {
    const intent = detectAttributeIntentFromKeywords('What flavors do you have?');
    assert.equal(intent?.is_attribute_question, true);
    assert.equal(intent?.is_product_knowledge_question, true);
    assert.ok(intent?.attributes.includes('flavor'));
    assert.equal(intent?.source, 'regex');
  });

  it('detects Albanian attribute follow-ups', () => {
    const intent = detectAttributeIntentFromKeywords('Cfare shijesh keni?');
    assert.equal(intent?.is_attribute_question, true);
    assert.ok(intent?.attributes.includes('flavor'));
  });

  it('detects material questions via keywords', () => {
    const intent = detectAttributeIntentFromKeywords('What material is this made of?');
    assert.equal(intent?.is_attribute_question, true);
    assert.ok(intent?.attributes.includes('material'));
  });

  it('detects implicit flavor selection', () => {
    const attrs = detectImplicitAttributeSelection('I want chocolate only');
    assert.ok(attrs.includes('flavor'));
    assert.equal(isAttributeQuestionMessage('I want chocolate only'), true);
  });

  it('detects implicit size selection', () => {
    const attrs = detectImplicitAttributeSelection('Only the 2kg one please');
    assert.ok(attrs.includes('size') || attrs.includes('weight'));
  });

  it('detects vegan catalog questions via keyword cue', () => {
    assert.equal(hasProductKnowledgeKeywordCue('Is it vegan?'), true);
    const intent = detectAttributeIntentFromKeywords('Is it vegan?');
    assert.equal(intent?.is_product_knowledge_question, true);
  });

  it('returns null for unrelated chit-chat', () => {
    assert.equal(detectAttributeIntentFromKeywords('hello there'), null);
    assert.equal(isAttributeQuestionMessage('hello'), false);
  });

  it('allows long attribute follow-up messages up to 250 chars', () => {
    const msg =
      'What flavors do you have for the mass gainer pro line that you showed me earlier in this conversation about supplements?';
    assert.ok(msg.length >= 120);
    const intent = detectAttributeIntentFromKeywords(msg);
    assert.equal(intent?.is_attribute_question, true);
    assert.equal(intent?.source, 'regex');
  });

  it('detects packaging attribute questions', () => {
    const intent = detectAttributeIntentFromKeywords('Which packaging options do you offer?');
    assert.ok(intent?.attributes.includes('packaging'));
  });
});
