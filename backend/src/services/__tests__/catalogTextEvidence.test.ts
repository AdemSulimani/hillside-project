/**
 * Tests for the P0-2 evidence-aware catalog text modes (description investigation).
 *
 * The defect: the generator's catalog context truncated description/usage text to a
 * query-agnostic 200-char prefix slice unless a fixed-vocabulary regex fired, so a
 * factual question with no cue word ("a eshte pa sheqer?", "is it gluten free?") got
 * a prompt from which the answer was physically absent (187/219 dev descriptions
 * exceed 200 chars; the recorded sugar-question turn had its answer at char ~1150).
 *
 * computeCatalogTextEvidence is the deterministic escape hatch: a folded question
 * token found in a product's own text BEYOND the brief boundary escalates that
 * product to full mode (top-K, char-budgeted) or, past the budget, to extracted
 * verbatim sentences. Pure — no network, no DB, no LLM.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_DESCRIPTION_BRIEF_MAX_CHARS,
  computeCatalogTextEvidence,
  formatCatalogDescriptionExcerpts,
  formatCatalogUsageExcerpts,
} from '../productDescriptionPromptService';

/** A description whose interesting fact sits far beyond the brief slice. */
function longDescriptionWithTail(tail: string, padSentences = 12): string {
  const filler = Array.from(
    { length: padSentences },
    (_, i) => `Ky produkt ofron cilesi te larta dhe perdoret gjeresisht nga sportistet seriozisht ${i}.`,
  ).join(' ');
  return `${filler} ${tail}`;
}

const SUGAR_TAIL = 'Sheqer i reduktuar: formula permban karbohidrate komplekse dhe eshte me e ulet ne sheqer krahasuar me formulen e vjeter.';

describe('computeCatalogTextEvidence — escalation on evidence beyond the brief slice', () => {
  it('escalates to full when the question token sits past the brief boundary (the recorded sugar case)', () => {
    const description = longDescriptionWithTail(SUGAR_TAIL);
    assert.ok(description.length > CATALOG_DESCRIPTION_BRIEF_MAX_CHARS * 3, 'fixture must be long');
    const result = computeCatalogTextEvidence(
      'A eshte pa sheqer Mega mass 3kg Vanil?',
      [{ id: 'p1', description, usage_description: null }],
    );
    assert.equal(result.briefOnlyMiss, true);
    assert.equal(result.fullCount, 1);
    assert.equal(result.decisions.get('p1')?.descriptionMode, 'full');
    assert.equal(result.decisions.get('p1')?.usageMode, 'brief');
  });

  it('escalates for an English factual question with no regex cue word ("is it gluten free?")', () => {
    const description = longDescriptionWithTail('This formula is completely gluten free and safe for celiacs.');
    const result = computeCatalogTextEvidence('is it gluten free?', [
      { id: 'p1', description, usage_description: null },
    ]);
    assert.equal(result.decisions.get('p1')?.descriptionMode, 'full');
  });

  it('matches across diacritics (question "kafeinë" vs folded text "kafeine")', () => {
    const description = longDescriptionWithTail('Permban kafeine natyrale nga kokrra kafeje.');
    const result = computeCatalogTextEvidence('a ka kafeinë brenda?', [
      { id: 'p1', description, usage_description: null },
    ]);
    assert.equal(result.decisions.get('p1')?.descriptionMode, 'full');
  });

  it('matches an inflected question token against the base form in the text (sheqerin → sheqer)', () => {
    const description = longDescriptionWithTail(SUGAR_TAIL);
    const result = computeCatalogTextEvidence('a e ka sheqerin e larte?', [
      { id: 'p1', description, usage_description: null },
    ]);
    assert.equal(result.decisions.get('p1')?.descriptionMode, 'full');
  });

  it('escalates the usage field independently of the description', () => {
    const usage = longDescriptionWithTail('Merrni nje luge pas stervitjes me 250 ml qumesht.');
    const result = computeCatalogTextEvidence('sa qumesht duhet me e perzier?', [
      { id: 'p1', description: 'Proteine e paster.', usage_description: usage },
    ]);
    const decision = result.decisions.get('p1');
    assert.equal(decision?.usageMode, 'full');
    assert.equal(decision?.descriptionMode, 'brief');
  });
});

describe('computeCatalogTextEvidence — no false escalations', () => {
  it('does nothing when the token already appears inside the brief slice', () => {
    const result = computeCatalogTextEvidence('a ka sheqer?', [
      { id: 'p1', description: 'Permban sheqer dhe qumesht.', usage_description: null },
    ]);
    assert.equal(result.briefOnlyMiss, false);
    assert.equal(result.decisions.size, 0);
  });

  it('does nothing when the question is stopwords only', () => {
    const description = longDescriptionWithTail(SUGAR_TAIL);
    const result = computeCatalogTextEvidence('a ka? cfare eshte per mua', [
      { id: 'p1', description, usage_description: null },
    ]);
    assert.equal(result.decisions.size, 0);
  });

  it('does not escalate on generic verbs like "permban"/"contains"', () => {
    const description = longDescriptionWithTail('Permban vitamina dhe minerale thelbesore.');
    const result = computeCatalogTextEvidence('a permban dicka tjeter?', [
      { id: 'p1', description, usage_description: null },
    ]);
    // 'permban' is stopworded; 'dicka'/'tjeter' are not in the text.
    assert.equal(result.decisions.size, 0);
  });

  it('skips products with no text at all', () => {
    const result = computeCatalogTextEvidence('a ka sheqer?', [
      { id: 'p1', description: null, usage_description: null },
    ]);
    assert.equal(result.decisions.size, 0);
  });

  it('returns an empty result for an empty question', () => {
    const description = longDescriptionWithTail(SUGAR_TAIL);
    const result = computeCatalogTextEvidence('', [{ id: 'p1', description, usage_description: null }]);
    assert.equal(result.decisions.size, 0);
    assert.equal(result.briefOnlyMiss, false);
  });
});

describe('computeCatalogTextEvidence — budget and cap degradation', () => {
  it('degrades to extract (never the blind prefix) when the char budget is exhausted', () => {
    const description = longDescriptionWithTail(SUGAR_TAIL);
    const result = computeCatalogTextEvidence(
      'a eshte pa sheqer?',
      [
        { id: 'p1', description, usage_description: null },
        { id: 'p2', description, usage_description: null },
      ],
      { maxFullProducts: 3, fullTextBudgetChars: description.length + 10 },
    );
    assert.equal(result.fullCount, 1);
    assert.equal(result.extractCount, 1);
    const degraded = [...result.decisions.values()].find((d) => d.descriptionMode === 'extract');
    assert.ok(degraded, 'second product must degrade to extract');
    assert.ok(
      degraded.descriptionExcerpts?.some((s) => s.toLowerCase().includes('sheqer')),
      'excerpts must carry the matching sentence',
    );
  });

  it('respects maxFullProducts even when the budget would allow more', () => {
    const description = longDescriptionWithTail(SUGAR_TAIL);
    const products = ['p1', 'p2', 'p3'].map((id) => ({
      id,
      description,
      usage_description: null,
    }));
    const result = computeCatalogTextEvidence('a eshte pa sheqer?', products, {
      maxFullProducts: 1,
      fullTextBudgetChars: 100_000,
    });
    assert.equal(result.fullCount, 1);
    assert.equal(result.extractCount, 2);
  });

  it('ranks products with more missed tokens first for the full slots', () => {
    const richDescription = longDescriptionWithTail(
      `${SUGAR_TAIL} Gjithashtu permban kafeine natyrale dhe laktoze nga qumeshti.`,
    );
    const poorDescription = longDescriptionWithTail(SUGAR_TAIL);
    const result = computeCatalogTextEvidence(
      'a ka sheqer, kafeine apo laktoze?',
      [
        { id: 'poor', description: poorDescription, usage_description: null },
        { id: 'rich', description: richDescription, usage_description: null },
      ],
      { maxFullProducts: 1, fullTextBudgetChars: 100_000 },
    );
    assert.equal(result.decisions.get('rich')?.descriptionMode, 'full');
    assert.equal(result.decisions.get('poor')?.descriptionMode, 'extract');
  });
});

describe('excerpt formatting', () => {
  it('renders description excerpts as a single internal-reference line', () => {
    const line = formatCatalogDescriptionExcerpts(['Permban sheqer te reduktuar.']);
    assert.ok(line);
    assert.match(line, /Relevant description excerpts/);
    assert.match(line, /Permban sheqer te reduktuar\./);
  });

  it('returns null / empty for no excerpts', () => {
    assert.equal(formatCatalogDescriptionExcerpts([]), null);
    assert.deepEqual(formatCatalogUsageExcerpts([]), []);
  });
});
