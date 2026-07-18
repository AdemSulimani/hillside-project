/**
 * P3-5 (RC-26): the whole-prompt section budget.
 *
 * The load-bearing assertion in this file is the BYTE-IDENTITY one: `aiService` was refactored
 * from ~15 `systemPrompt += X` statements into a declared section list, and that refactor is only
 * safe if joining the list reproduces the concatenation exactly. Everything else here is the
 * priority contract — in particular that the injected product catalog can never be truncated,
 * because trimming it reintroduces RC-02 through the budget: the guards validate against the FULL
 * active catalog, so a product cut from the prompt becomes one the model cannot see but the guard
 * still accepts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySectionBudget,
  joinSections,
  type PromptSection,
} from '../promptSectionBudget';

const s = (id: string, text: string, priority: PromptSection['priority']): PromptSection => ({
  id,
  text,
  priority,
});

/** The shape aiService declares: protected core, then situational, then style polish. */
function realisticSections(): PromptSection[] {
  return [
    s('base', 'B'.repeat(20_000), 'protected'),
    s('image_not_in_catalog', 'I'.repeat(400), 'high'),
    s('category_aggregation', 'C'.repeat(300), 'normal'),
    s('other_options', 'O'.repeat(500), 'normal'),
    s('shortest_answer', 'S'.repeat(2_397), 'low'),
    s('description_concise', 'D'.repeat(1_813), 'low'),
    s('price_list_compact', 'P'.repeat(600), 'low'),
    s('description_targeted', 'T'.repeat(700), 'low'),
    s('restrictions_footer', 'F'.repeat(2_200), 'protected'),
    s('grounding_directive', 'G'.repeat(900), 'protected'),
  ];
}

describe('applySectionBudget — byte identity (the refactor guard)', () => {
  it('an unbounded budget reproduces plain concatenation exactly', () => {
    const sections = realisticSections();
    assert.equal(applySectionBudget(sections, Infinity).prompt, joinSections(sections));
  });

  it('a budget nothing exceeds also reproduces it exactly', () => {
    const sections = realisticSections();
    assert.equal(applySectionBudget(sections, 1_000_000).prompt, joinSections(sections));
  });

  it('maxChars <= 0 means no ceiling, not "drop everything"', () => {
    const sections = realisticSections();
    assert.equal(applySectionBudget(sections, 0).prompt, joinSections(sections));
    assert.equal(applySectionBudget(sections, -1).droppedIds.length, 0);
  });

  it('empty input is the empty prompt', () => {
    const result = applySectionBudget([], 100);
    assert.equal(result.prompt, '');
    assert.equal(result.overBudget, false);
    assert.deepEqual(result.sections, []);
  });
});

describe('applySectionBudget — drop order', () => {
  it('drops `low` before `normal` before `high`, and never `protected`', () => {
    const sections = [
      s('p', 'p'.repeat(100), 'protected'),
      s('h', 'h'.repeat(100), 'high'),
      s('n', 'n'.repeat(100), 'normal'),
      s('l', 'l'.repeat(100), 'low'),
    ];
    assert.deepEqual(applySectionBudget(sections, 350).droppedIds, ['l']);
    assert.deepEqual(applySectionBudget(sections, 250).droppedIds, ['l', 'n']);
    assert.deepEqual(applySectionBudget(sections, 150).droppedIds, ['l', 'n', 'h']);
    // Only protected left, still over: report, do not cut.
    const floor = applySectionBudget(sections, 50);
    assert.deepEqual(floor.droppedIds, ['l', 'n', 'h']);
    assert.equal(floor.prompt, 'p'.repeat(100));
    assert.equal(floor.overBudget, true);
  });

  it('within a tier the LAST-declared section goes first', () => {
    // Declaration order runs foundational-first, so the tail is the most situational. This is the
    // same rule `applyGuidelineBudget` uses, deliberately.
    const sections = [
      s('keep', 'k'.repeat(100), 'protected'),
      s('low_first', 'a'.repeat(50), 'low'),
      s('low_second', 'b'.repeat(50), 'low'),
    ];
    assert.deepEqual(applySectionBudget(sections, 160).droppedIds, ['low_second']);
  });

  it('the realistic shape sheds the style appends in the documented order', () => {
    // targeted -> price_list -> concise -> shortest, i.e. reverse declaration within `low`.
    const sections = realisticSections();
    const order: string[] = [];
    for (const budget of [29_800, 29_200, 27_400, 25_100]) {
      const dropped = applySectionBudget(sections, budget).droppedIds;
      for (const id of dropped) if (!order.includes(id)) order.push(id);
    }
    assert.deepEqual(order, [
      'description_targeted',
      'price_list_compact',
      'description_concise',
      'shortest_answer',
    ]);
  });
});

describe('applySectionBudget — what may never be cut', () => {
  it('the base section carrying the injected product catalog is never dropped', () => {
    // RC-02 through the budget: the guards validate against the FULL active catalog, so a product
    // trimmed out of the prompt becomes one the model cannot see but the guard still accepts —
    // "we don't carry that" about an in-stock item, passing every check.
    const sections = realisticSections();
    const result = applySectionBudget(sections, 10);
    assert.ok(!result.droppedIds.includes('base'));
    assert.ok(result.prompt.includes('B'.repeat(20_000)));
  });

  it('the restrictions footer and grounding directive survive any budget', () => {
    const result = applySectionBudget(realisticSections(), 1);
    assert.ok(!result.droppedIds.includes('restrictions_footer'));
    assert.ok(!result.droppedIds.includes('grounding_directive'));
    assert.ok(result.prompt.includes('F'.repeat(2_200)));
    assert.ok(result.prompt.includes('G'.repeat(900)));
  });

  it('never throws, however small the budget', () => {
    assert.doesNotThrow(() => applySectionBudget(realisticSections(), 1));
    assert.doesNotThrow(() => applySectionBudget([s('p', 'x', 'protected')], 0));
  });
});

describe('applySectionBudget — accounting', () => {
  it('reports every section with its size and dropped state', () => {
    const result = applySectionBudget(realisticSections(), 25_100);
    assert.equal(result.sections.length, 10);
    const byId = new Map(result.sections.map((x) => [x.id, x]));
    assert.equal(byId.get('base')?.chars, 20_000);
    assert.equal(byId.get('base')?.dropped, false);
    assert.equal(byId.get('shortest_answer')?.dropped, true);
    // chars is the section's own size even when dropped — that is what makes the shadow window
    // able to answer "how much would enforcing have cost us".
    assert.equal(byId.get('shortest_answer')?.chars, 2_397);
  });

  it('totalChars counts survivors only and matches the emitted prompt', () => {
    const result = applySectionBudget(realisticSections(), 25_100);
    assert.equal(result.totalChars, result.prompt.length);
  });

  it('overBudget is false once the drops brought it under', () => {
    const result = applySectionBudget(realisticSections(), 25_100);
    assert.ok(result.totalChars <= 25_100);
    assert.equal(result.overBudget, false);
  });

  it('kept sections stay in declaration order — a subsequence, never a reordering', () => {
    const sections = [
      s('a', 'AAA', 'protected'),
      s('b', 'BBB', 'low'),
      s('c', 'CCC', 'protected'),
    ];
    assert.equal(applySectionBudget(sections, 6).prompt, 'AAACCC');
  });

  it('skips nothing when sections are empty strings (aiService filters those out first)', () => {
    // `section()` in aiService drops falsy text before pushing, so an empty section never reaches
    // here. Asserted so a future caller that stops filtering gets a defined answer rather than a
    // surprise: an empty section is simply weightless.
    const result = applySectionBudget([s('empty', '', 'low'), s('p', 'xx', 'protected')], 1);
    assert.equal(result.prompt, 'xx');
  });
});
