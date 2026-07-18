/**
 * Unit tests for the live-replay aggregator (P3-4, RC-03).
 *
 * `summarizeReplays` is the arithmetic behind `distinctRepliesPerInput` — the measurement the audit
 * used to prove reply generation is non-deterministic ([1, 3, 8] for three fixed inputs). It is
 * deliberately pure and separated from the runner that calls the model, so the counting can be
 * verified without spending a cent. That split is the same one `shadowDiff.buildShadowDiffReport`
 * uses, and for the same reason: the number that drives a decision should not be reachable only
 * through a paid, non-deterministic code path.
 *
 * Pure/in-process: no network, DB, Redis or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReplays } from '../replaySummary';

const CATALOG = [
  'MATCHING PRODUCTS:',
  '- Carbo one 1kg Limon | brand: (none) | flavor: Limon | weight: 1kg | price: 18.00',
  '- Mega mass 3kg Vanil | brand: (none) | flavor: Vanil | weight: 3kg | price: 55.00',
].join('\n');

const base = {
  id: 'IN1',
  text: 'a keni carbo one',
  injectedCatalogText: CATALOG,
  catalogNames: ['Carbo one 1kg Limon', 'Mega mass 3kg Vanil'],
  catalogPriceRows: [
    { price: '18.00', discounted_price: null },
    { price: '55.00', discounted_price: null },
  ],
};

describe('distinctReplies — the RC-03 measurement', () => {
  it('IN1-shaped degenerate collapse: 8 identical replies count as 1', () => {
    // The audit measured exactly this: every IN1 run returned "Po.".
    const r = summarizeReplays({ ...base, replies: Array.from({ length: 8 }, () => 'Po.') });
    assert.equal(r.runs, 8);
    assert.equal(r.distinctReplies, 1);
  });

  it('IN3-shaped maximal divergence: 8 different replies count as 8', () => {
    const replies = Array.from({ length: 8 }, (_, i) => `Ju rekomandoj opsionin numer ${i}.`);
    assert.equal(summarizeReplays({ ...base, replies }).distinctReplies, 8);
  });

  it('normalizes whitespace and case — cosmetic differences are not divergence', () => {
    const r = summarizeReplays({
      ...base,
      replies: ['Po, e kemi.', '  po,   e kemi.  ', 'PO, E KEMI.'],
    });
    assert.equal(r.distinctReplies, 1);
  });

  it('does NOT normalize semantics — a different product named is a different reply', () => {
    const r = summarizeReplays({
      ...base,
      replies: ['Kemi Carbo one 1kg Limon.', 'Kemi Mega mass 3kg Vanil.'],
    });
    assert.equal(r.distinctReplies, 2);
  });

  it('keeps a bounded sample of the distinct replies, in first-seen order', () => {
    const replies = Array.from({ length: 10 }, (_, i) => `Reply ${i}`);
    const r = summarizeReplays({ ...base, replies });
    assert.equal(r.samples.length, 4);
    assert.equal(r.samples[0], 'Reply 0');
  });

  it('handles a single run and an empty run list without dividing by anything', () => {
    assert.equal(summarizeReplays({ ...base, replies: ['Po.'] }).distinctReplies, 1);
    const empty = summarizeReplays({ ...base, replies: [] });
    assert.equal(empty.runs, 0);
    assert.equal(empty.distinctReplies, 0);
    assert.equal(empty.fabricationViolations, 0);
  });
});

describe('fabrication counting across runs', () => {
  it('grounded replies produce no violations', () => {
    const r = summarizeReplays({
      ...base,
      replies: ['Po, kemi Carbo one 1kg Limon. Kushton €18.00.', 'Kemi Mega mass 3kg Vanil.'],
    });
    assert.equal(r.fabricationViolations, 0);
    assert.deepEqual(r.fabricatedSpans, []);
  });

  it('counts RUNS that fabricated, not total violations — the metric is "how often"', () => {
    const r = summarizeReplays({
      ...base,
      replies: [
        'Po, kemi Carbo one 1kg Limon.', // clean
        'Ju rekomandoj Ghost Whey Isolate.', // 3 ungrounded tokens, but ONE bad run
        'Ju rekomandoj Ghost Whey Isolate.', // same text — still one more bad run
      ],
    });
    assert.equal(r.fabricationViolations, 2);
  });

  it('collects every distinct fabricated span across runs, sorted for diffability', () => {
    const r = summarizeReplays({
      ...base,
      replies: ['Ju rekomandoj Ghost Isolate.', 'Ju rekomandoj Alpha Fuel.'],
    });
    assert.deepEqual(r.fabricatedSpans, [...r.fabricatedSpans].sort());
    assert.ok(r.fabricatedSpans.includes('Ghost'));
    assert.ok(r.fabricatedSpans.includes('Alpha'));
  });

  it('the BSN class: divergence and fabrication are reported independently', () => {
    // The audit's key observation — the 8-way-divergent input was also the fabricating one, but
    // the two are separate measurements and a reply can be stable AND wrong.
    const r = summarizeReplays({
      ...base,
      injectedCatalogText: 'MATCHING PRODUCTS:\n- BSN Creatine 300gr | brand: BSN | price: 28.00',
      catalogNames: ['BSN Creatine 300gr'],
      catalogPriceRows: [{ price: '28.00', discounted_price: null }],
      replies: Array.from(
        { length: 4 },
        () => 'BSN eshte shkurtesa e Bio-Engineered Supplements and Nutrition.',
      ),
    });
    assert.equal(r.distinctReplies, 1, 'stable wording');
    assert.equal(r.fabricationViolations, 4, 'and wrong on every run');
    assert.ok(r.fabricatedSpans.includes('Bio-Engineered'));
  });
});
