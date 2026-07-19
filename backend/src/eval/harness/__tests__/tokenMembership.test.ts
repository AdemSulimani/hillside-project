/**
 * Unit tests for the fabrication checker's mechanics (P3-4, RC-03).
 *
 * The corpus-level assertions live in `goldenSets/__tests__/fabricationGolden.test.ts`. This file
 * pins the EXTRACTOR, because that is where a silent failure would be invisible: an extractor that
 * stops extracting reports `ok: true` on every input forever, and a release gate that can no longer
 * fail looks exactly like a release gate that is passing.
 *
 * Pure/in-process: no network, DB, Redis or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkClaimTokenMembership, describeViolations } from '../tokenMembership';
import { buildPriceSetFromCatalogRows } from '../../../services/catalogGuardReferenceService';

// NOTE: the `findSrcDir` helper and the node:fs/node:path imports were removed with P3-1. They
// existed solely for the source-text tripwire that asserted `groundingGate.ts` did NOT consume
// `f.type === 'attribute'`. That tripwire fired when the lane landed, which was its whole purpose,
// so it was deleted. The equivalent invariant now lives, inverted, in
// `services/__tests__/groundingGateAttributeLane.test.ts` (the "source tripwire" describe) — it
// asserts BOTH type filters are present, so the gap cannot be silently un-closed in either
// direction.

const CATALOG_TEXT = [
  'MATCHING PRODUCTS:',
  '- Carbo one 1kg Limon | brand: (none) | flavor: Limon | weight: 1kg | price: 18.00',
  '- Mega mass 3kg Vanil | brand: (none) | flavor: Vanil | weight: 3kg | price: 55.00',
].join('\n');
const CATALOG_NAMES = ['Carbo one 1kg Limon', 'Mega mass 3kg Vanil'];
const PRICE_SET = buildPriceSetFromCatalogRows([
  { price: '18.00', discounted_price: null },
  { price: '55.00', discounted_price: null },
]);

const check = (replyText: string, customerText = ''): ReturnType<typeof checkClaimTokenMembership> =>
  checkClaimTokenMembership({
    replyText,
    injectedCatalogText: CATALOG_TEXT,
    catalogNameIndex: CATALOG_NAMES,
    priceSet: PRICE_SET,
    customerText,
  });

describe('grounded claims are never violations', () => {
  it('a catalog product name mid-sentence', () => {
    const r = check('Ju rekomandoj Mega mass 3kg Vanil sot.');
    assert.deepEqual(r.violations, [], describeViolations('grounded name', r));
    assert.ok(r.candidatesChecked > 0, 'extractor produced no candidates — it is not running');
  });

  it('a catalog price', () => {
    assert.equal(check('Kushton €18.00.').ok, true);
  });

  it('a catalog quantity, with or without the space', () => {
    assert.equal(check('Kemi paketën 3kg.').ok, true);
    assert.equal(check('Kemi paketën 3 kg.').ok, true);
  });

  it("the customer's own words, even when absent from the catalog", () => {
    const r = check('Po, Nitro Tech Ripped e kemi.', 'a keni Nitro Tech Ripped');
    assert.equal(r.ok, true, describeViolations('customer echo', r));
  });
});

describe('fabricated claims are violations', () => {
  it('an invented product name', () => {
    const r = check('Ju rekomandoj Ghost Whey Isolate.');
    assert.equal(r.ok, false);
    assert.deepEqual(
      r.violations.map((v) => v.span).sort(),
      ['Ghost', 'Isolate', 'Whey'],
    );
    assert.ok(r.violations.every((v) => v.kind === 'name'));
  });

  it('an invented price', () => {
    const r = check('Çmimi është €23.50.');
    assert.equal(r.ok, false);
    assert.deepEqual(r.violations.map((v) => v.kind), ['price']);
    assert.equal(r.violations[0].span, '23.50');
  });

  it('an invented strength claim, reported as a QUANTITY not a name', () => {
    const r = check('Jep 5000mg për porcion.');
    assert.equal(r.ok, false);
    // The kind matters: it tells the reader which guard class the defect belongs to.
    assert.deepEqual(r.violations.map((v) => v.kind), ['quantity']);
  });
});

describe('the false-positive controls that make this usable on real prose', () => {
  it('a sentence-initial capital is not a brand', () => {
    assert.equal(check('Po. Faleminderit.').ok, true);
  });

  it('a bullet-initial capital is not a brand', () => {
    assert.equal(check('Kemi:\n- Carbo one 1kg Limon\n- Mega mass 3kg Vanil').ok, true);
  });

  it('a capital after a colon is not a brand', () => {
    assert.equal(check('Shijet: Limon, Vanil.').ok, true);
  });

  it('lowercase Albanian letters are not read as uppercase (the À-ſ range trap)', () => {
    // `ë` and `ç` sit inside U+00C0–U+017F, so a naive [A-ZÀ-ſ] class treats every Albanian word
    // as a proper noun. Nothing in this sentence is a product claim.
    const r = check('Kjo është një zgjedhje e shkëlqyer për ju çdo ditë.');
    assert.equal(r.ok, true, describeViolations('albanian prose', r));
  });

  it('a bare numeral is not a product claim (the €31.90 → "31","90" noise class)', () => {
    const r = check('Kemi 2 opsione dhe 10 ngjyra.');
    assert.equal(r.violations.filter((v) => v.kind === 'name').length, 0);
  });

  it('ALL-CAPS punctuation-only runs are not claims', () => {
    assert.equal(check('Po!!! ---').ok, true);
  });
});

describe('anti-vacuity: the checker can actually fail', () => {
  it('MUTATION GUARD — a synthetic token injected into a clean reply is caught', () => {
    const clean = 'Ju rekomandoj Mega mass 3kg Vanil sot.';
    assert.equal(check(clean).ok, true);
    const mutated = 'Ju rekomandoj Mega mass 3kg Vanil dhe Zzqfakebrandix sot.';
    const r = check(mutated);
    assert.equal(r.ok, false, 'the extractor did not run over the mutated text');
    assert.deepEqual(r.violations.map((v) => v.span), ['Zzqfakebrandix']);
  });

  /**
   * PLACEMENT SENSITIVITY — the regression these exist for.
   *
   * The original extractor exempted every position-initial token, and the only mutation guard
   * injected mid-sentence. So a fabricated brand opening a sentence, a line, or a bullet was
   * missed (measured: 5/7 and 7/7 against the negative corpus) while the suite stayed green — and
   * the RC-03 case the whole check exists for is a brand claim in exactly that position. One
   * mutation placement is not a mutation guard.
   */
  for (const [placement, mutate] of [
    ['mid-sentence', (r: string) => `${r.replace(/\.\s*$/, '')} dhe ${'Zzqfakebrandix'}.`],
    ['opening a new sentence', (r: string) => `${r} Zzqfakebrandix e prodhon.`],
    ['opening the reply', (r: string) => `Zzqfakebrandix. ${r}`],
    ['opening a bullet', (r: string) => `${r}\n- Zzqfakebrandix`],
    ['after a colon', (r: string) => `${r}\nMarka: Zzqfakebrandix`],
    ['appended to a real product name', (r: string) => `${r} Zzqfakebrandix`],
  ] as Array<[string, (r: string) => string]>) {
    it(`MUTATION GUARD — caught when ${placement}`, () => {
      const clean = 'Ju rekomandoj Mega mass 3kg Vanil sot.';
      assert.equal(check(clean).ok, true, 'baseline reply is not clean — test setup is wrong');
      const r = check(mutate(clean));
      assert.equal(r.ok, false, `fabricated token missed when ${placement}: ${mutate(clean)}`);
      assert.ok(r.violations.some((v) => v.span === 'Zzqfakebrandix'));
    });
  }

  it('reports candidatesChecked so a dead extractor is visible', () => {
    assert.ok(check('Ju rekomandoj Mega mass 3kg Vanil.').candidatesChecked > 0);
  });

  it('a repeated fabrication is one defect, not three', () => {
    const r = check('Zzqfakebrandix. Ne kemi Zzqfakebrandix. Merrni Zzqfakebrandix.');
    // First occurrence is sentence-initial and exempt; the other two dedupe to one violation.
    assert.equal(r.violations.length, 1);
  });
});

describe('KNOWN RECALL GAPS — what this checker deliberately does NOT catch', () => {
  /**
   * Recorded as passing tests rather than left as an unwritten assumption, because the dangerous
   * failure of a release gate is someone believing it covers more than it does.
   *
   * All three below are fabrications the checker reports as clean. That is the cost of the
   * precision bias: a false positive blocks a deploy, so extraction is restricted to spans in
   * claim POSITION (capitalised, ALL-CAPS, or digit-bearing). A fabricated claim written entirely
   * in lowercase Albanian prose has no such marker, and catching it would need semantics — i.e. a
   * judge, which is exactly what RC-03 says not to rely on for this.
   *
   * ⚠️ WHAT THE `facts_used` CONTRACT NOW COVERS — AND WHAT IT STILL DOES NOT (P3-1).
   *
   * P3-1 landed the declared-attribute lane: `evaluateConsolidatedGrounding` now consumes
   * `f.type === 'attribute'` and, behind `GROUNDING_GATE_ATTRIBUTE_FACTS`, strips or escalates a
   * declared exclusion claim on the SEND path. So the third case below is no longer unguarded at
   * every layer — but only for its CONTRADICTION half, and the distinction matters:
   *
   *   - CONTRADICTED (guarded): the resolved product's own catalog text asserts the opposite. The
   *     real row behind case 3 reads "Sheqer i reduktuar ... më e ulët në sheqer", so "pa sheqer"
   *     is refuted and the lane fires.
   *   - SILENT (still open, by design): the catalog says nothing about the substance. 218 of 257
   *     active rows are silent on sugar and most supplements genuinely ARE sugar-free — the
   *     merchant just never wrote it down — so flagging silence would strip TRUE sentences into a
   *     pause that has no automatic exit. Closing that half needs merchant-supplied structured
   *     dietary data, not a cleverer text predicate.
   *
   * Two further limits worth naming: the lane judges DECLARED facts only (an undeclared attribute
   * claim in prose has no deterministic backstop, unlike prices), and only substances in a closed
   * lexicon. None of that is fixable HERE — this module is a CI instrument that never runs on the
   * send path, so nothing it does can stop such a reply reaching a customer.
   *
   * The three cases below still pass unchanged: this CHECKER is untouched by P3-1 and genuinely
   * cannot see any of them. Detection-side they belong to the LIVE runner
   * (`npm run eval:live-replay`), which at least sees real generated prose. If one of them ever
   * starts failing, that is a capability improvement: update the test, do not weaken the checker.
   */
  it('MISSES an all-lowercase invented claim (no capital, no digit → no claim position)', () => {
    assert.equal(check('kjo permban shume proteina dhe ndihmon per muskuj').ok, true);
  });

  it('MISSES an invented property expressed without any proper noun or quantity', () => {
    assert.equal(check('ky produkt eshte i importuar nga gjermania').ok, true);
  });

  it('MISSES a false statement built entirely from catalog words', () => {
    // Every token is grounded; only the CLAIM is false. Membership cannot see this by construction.
    // P3-1 closed this on the SEND path (contradiction half only) — this CHECKER still cannot see
    // it, and that is the point of recording it here. See the note above.
    assert.equal(check('Mega mass 3kg Vanil eshte pa sheqer').ok, true);
  });
});

describe('describeViolations', () => {
  it('names the spans and the kind', () => {
    const msg = describeViolations('FAB', check('Ju rekomandoj Ghost Isolate.'));
    assert.match(msg, /FAB/);
    assert.match(msg, /\[name\]/);
    assert.match(msg, /Ghost/);
  });

  it('says clean, with the candidate count, when there is nothing to report', () => {
    assert.match(describeViolations('OK', check('Ju rekomandoj Mega mass 3kg Vanil.')), /clean \(\d+ candidates/);
  });
});
