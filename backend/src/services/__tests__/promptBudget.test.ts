/**
 * Tests for the conversation-history token budget (P2-5, RC-26 defects b and c).
 *
 * Each defect is pinned twice: once reproducing the legacy arithmetic (so the bug is documented
 * and flag-off byte-identity is provable) and once asserting the fix. All pure/in-process.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyHistoryBudget } from '../historyBudget';

/** Mirrors aiService's `estimateTokens` — chars/4, no rounding. */
const est = (text: string): number => text.length / 4;

interface Msg {
  id: string;
  content: string;
  /** The formatted form the prompt actually carries — longer than `content` in real rows. */
  formatted: string;
}

const msg = (id: string, content: string, formatted = content): Msg => ({ id, content, formatted });

function budgetFor(items: Msg[], opts: { summaryTokens?: number; maxTokens: number; reserveSummary: boolean }) {
  return applyHistoryBudget({
    items,
    itemTokens: items.map((m) => est(m.formatted)),
    evictionTokens: items.map((m) => est(m.content)),
    summaryTokens: opts.summaryTokens ?? 0,
    maxTokens: opts.maxTokens,
    reserveSummary: opts.reserveSummary,
  });
}

describe('applyHistoryBudget — baseline', () => {
  it('keeps everything when the history fits', () => {
    const items = [msg('a', 'x'.repeat(40)), msg('b', 'x'.repeat(40))];
    for (const reserveSummary of [false, true]) {
      const out = budgetFor(items, { maxTokens: 1000, reserveSummary });
      assert.equal(out.kept.length, 2);
      assert.equal(out.evictedCount, 0);
    }
  });

  it('evicts from the OLDEST end', () => {
    const items = [msg('a', 'x'.repeat(400)), msg('b', 'x'.repeat(400)), msg('c', 'x'.repeat(400)), msg('d', 'x'.repeat(400))];
    const out = budgetFor(items, { maxTokens: 300, reserveSummary: true });
    assert.equal(out.kept[0].id, 'b');
    assert.equal(out.evictedCount, 1);
  });

  it('never evicts below the minKeep floor', () => {
    const items = ['a', 'b', 'c', 'd', 'e'].map((id) => msg(id, 'x'.repeat(4000)));
    const out = budgetFor(items, { maxTokens: 1, reserveSummary: true });
    assert.equal(out.kept.length, 3, 'the legacy floor is `length > 3` -> 3 remain');
  });

  it('is a no-op on an empty history', () => {
    const out = budgetFor([], { maxTokens: 10, reserveSummary: true });
    assert.deepEqual(out.kept, []);
    assert.equal(out.total, 0);
  });
});

describe('defect (b) — the total must be decremented with the estimates that seeded it', () => {
  // Real customer rows are seeded with formatCustomerMessageContentForPrompt(msg) but the legacy
  // loop subtracted estimateTokens(msg.content). Here `formatted` is 4x `content`, the shape a
  // message with attachments or injected product context actually has.
  const items = [
    msg('a', 'x'.repeat(100), 'x'.repeat(400)),
    msg('b', 'x'.repeat(100), 'x'.repeat(400)),
    msg('c', 'x'.repeat(100), 'x'.repeat(400)),
    msg('d', 'x'.repeat(100), 'x'.repeat(400)),
    msg('e', 'x'.repeat(100), 'x'.repeat(400)),
  ];

  it('legacy: under-subtracts, so the total drifts above the truth and it over-evicts', () => {
    const out = budgetFor(items, { maxTokens: 150, reserveSummary: false });
    // Seeded with 5x100 formatted tokens = 500. Each eviction removes only 25 (the raw content),
    // so the total falls far more slowly than the content it actually removed.
    assert.equal(out.evictedCount, 2, 'legacy drops to the floor');
    assert.equal(out.kept.length, 3);
    // The remaining total is a fiction: it claims 450 while the kept history is really 300.
    assert.equal(out.total, 450);
    const trueRemaining = out.kept.reduce((s, m) => s + est(m.formatted), 0);
    assert.equal(trueRemaining, 300);
    assert.notEqual(out.total, trueRemaining, 'this drift IS the defect');
  });

  it('fixed: the total tracks the kept history exactly', () => {
    const out = budgetFor(items, { maxTokens: 150, reserveSummary: true });
    const trueRemaining = out.kept.reduce((s, m) => s + est(m.formatted), 0);
    assert.equal(out.total, trueRemaining, 'the accounting must match reality');
  });

  it('fixed: evicting everything down to the floor leaves the exact remaining total', () => {
    const out = budgetFor(items, { maxTokens: 0, reserveSummary: true });
    assert.equal(out.kept.length, 3);
    assert.equal(out.total, 300); // 3 kept x 100 formatted tokens
  });

  it('fixed: a fully-evictable history reaches exactly zero', () => {
    const three = [msg('a', 'x'.repeat(400)), msg('b', 'x'.repeat(400)), msg('c', 'x'.repeat(400))];
    const out = applyHistoryBudget({
      items: three,
      itemTokens: three.map((m) => est(m.formatted)),
      evictionTokens: three.map((m) => est(m.content)),
      summaryTokens: 0,
      maxTokens: 0,
      reserveSummary: true,
      minKeep: 0,
    });
    assert.equal(out.kept.length, 0);
    assert.equal(out.total, 0);
  });
});

describe('defect (c) — the un-evictable summary must be reserved, not added', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => msg(id, 'x'.repeat(400)));
  const SUMMARY_TOKENS = 90; // a large older-history summary

  it('legacy: a large summary pins the loop at the floor while still "over budget"', () => {
    const out = budgetFor(items, { summaryTokens: SUMMARY_TOKENS, maxTokens: 100, reserveSummary: false });
    assert.equal(out.kept.length, 3, 'evicted all the way to the floor');
    // Still over budget after evicting everything it could — the summary weight never moves.
    assert.ok(out.total > out.budget, 'the loop exits still over budget, having over-truncated');
  });

  it('fixed: the summary is reserved out of the budget instead of inflating the total', () => {
    const out = budgetFor(items, { summaryTokens: SUMMARY_TOKENS, maxTokens: 100, reserveSummary: true });
    assert.equal(out.budget, 10, 'budget = maxTokens - summaryTokens');
    assert.equal(out.total, 300, 'the total is the kept history alone, not history + summary');
  });

  it('fixed: with no summary, the reserved budget is the full budget', () => {
    const out = budgetFor(items, { summaryTokens: 0, maxTokens: 500, reserveSummary: true });
    assert.equal(out.budget, 500);
  });

  it('fixed: a summary larger than the whole budget floors at zero, never negative', () => {
    const out = budgetFor(items, { summaryTokens: 10_000, maxTokens: 100, reserveSummary: true });
    assert.equal(out.budget, 0);
    assert.ok(out.kept.length >= 3, 'the floor still protects the recent turns');
  });

  it('fixed: a small summary leaves room and evicts nothing', () => {
    const short = [msg('a', 'x'.repeat(40)), msg('b', 'x'.repeat(40))];
    const out = budgetFor(short, { summaryTokens: 5, maxTokens: 1000, reserveSummary: true });
    assert.equal(out.evictedCount, 0);
  });
});

describe('flag-off byte-identity with the legacy loop', () => {
  // Reproduces the exact legacy arithmetic independently and asserts the extracted function
  // agrees — the primary safety property of the whole extraction.
  function legacyLoop(items: Msg[], summaryTokens: number, maxTokens: number) {
    let historyForPrompt = [...items];
    let total = items.reduce((s, m) => s + est(m.formatted), 0) + summaryTokens;
    while (total > maxTokens && historyForPrompt.length > 3) {
      const [removed, ...rest] = historyForPrompt;
      historyForPrompt = rest;
      total -= est(removed.content);
    }
    return { kept: historyForPrompt, total };
  }

  const CASES: Array<{ n: number; summary: number; max: number }> = [
    { n: 10, summary: 0, max: 100 },
    { n: 10, summary: 50, max: 100 },
    { n: 3, summary: 0, max: 1 },
    { n: 6, summary: 200, max: 100 },
    { n: 12, summary: 10, max: 1000 },
    { n: 0, summary: 0, max: 10 },
  ];

  for (const { n, summary, max } of CASES) {
    it(`agrees with the legacy loop (n=${n}, summary=${summary}, max=${max})`, () => {
      const items = Array.from({ length: n }, (_, i) =>
        msg(`m${i}`, 'x'.repeat(100 + i * 10), 'x'.repeat(400 + i * 10)),
      );
      const legacy = legacyLoop(items, summary, max);
      const out = budgetFor(items, { summaryTokens: summary, maxTokens: max, reserveSummary: false });
      assert.deepEqual(out.kept.map((m) => m.id), legacy.kept.map((m) => m.id));
      assert.equal(out.total, legacy.total);
    });
  }
});
