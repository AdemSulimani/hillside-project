/**
 * P3-4 GOLDEN SET — fabrication token membership (RC-03). THIS IS A RELEASE GATE.
 *
 * THE FINDING: replaying one fixed prompt eight times at the live `AI_REPLY_TEMPERATURE=0.3`
 * produced eight different paragraphs, several fabricating "BSN = Bio-Engineered Supplements and
 * Nutrition" plus strength claims absent from the catalog. The product-name guard passed them
 * (it checks names, and "BSN" IS a catalog brand) and the quality eval scored them 0.95. Two
 * defences, neither of which could see the defect.
 *
 * ⚠️ NO PRE-FIX/POST-FIX SWITCH EXISTS HERE, AND THAT IS THE POINT. RC-01's meta-test flips a flag;
 * RC-02's flips an injected reference set. RC-03 has neither, because there was never a checker to
 * turn off — the fabrication came out of the MODEL. So the meta-test is corpus-based: run the NEW
 * checker over the RECORDED pre-fix text and assert it flags. A reader expecting "flag off =
 * pre-fix" will misread this file.
 *
 * THE NEGATIVE SET IS THE LOAD-BEARING HALF. A fabrication checker is trivially made to flag
 * everything; what makes it usable as a gate is silence on correct Albanian prose. Two of the
 * grounded cases are the very replies the live guards wrongly stripped — the checker must side with
 * the catalog, not with the alert.
 *
 * Offline: pure functions only. No DB, Redis, network or OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkClaimTokenMembership,
  describeViolations,
  TOKEN_MEMBERSHIP_ALLOWLIST,
  type TokenMembershipResult,
} from '../../harness/tokenMembership';
import { buildPriceSetFromCatalogRows } from '../../../services/catalogGuardReferenceService';
import {
  FABRICATED_REPLIES,
  GROUNDED_REPLIES,
  IN3_CATALOG_NAMES,
  IN3_CUSTOMER_TEXT,
  IN3_INJECTED_CATALOG,
  MUTATION_PROBE_TOKEN,
} from '../../corpora/fabrication';

/** Prices parsed out of a fixture's own catalog block, so the two can never drift apart. */
function priceSetOf(catalogText: string): ReturnType<typeof buildPriceSetFromCatalogRows> {
  return buildPriceSetFromCatalogRows(
    [...catalogText.matchAll(/price: ([\d.]+)/g)].map((m) => ({
      price: m[1],
      discounted_price: null,
    })),
  );
}

const IN3_PRICE_SET = priceSetOf(IN3_INJECTED_CATALOG);

const checkFabricated = (reply: string): TokenMembershipResult =>
  checkClaimTokenMembership({
    replyText: reply,
    injectedCatalogText: IN3_INJECTED_CATALOG,
    catalogNameIndex: IN3_CATALOG_NAMES,
    priceSet: IN3_PRICE_SET,
    customerText: IN3_CUSTOMER_TEXT,
  });

// ---------------------------------------------------------------------------
// The meta-test: the recorded fabrications must be caught
// ---------------------------------------------------------------------------

describe('RC-03 meta-test: the checker catches the audit\'s recorded fabrications', () => {
  for (const c of FABRICATED_REPLIES) {
    it(`${c.id} — flags ${c.expectViolationSpans.join(', ')}`, () => {
      const result = checkFabricated(c.reply);
      assert.equal(result.ok, false, `${c.id} was NOT flagged. ${c.rationale}`);
      assert.ok(
        result.candidatesChecked > 0,
        `${c.id}: zero candidates extracted — the extractor is not running`,
      );

      const reported = new Set(result.violations.map((v) => v.span));
      for (const span of c.expectViolationSpans) {
        assert.ok(
          reported.has(span),
          `${c.id}: expected "${span}" to be reported.\n${describeViolations(c.id, result)}`,
        );
      }
      // The KIND matters: it tells the reader which guard class the defect belongs to. A strength
      // claim reported as a "product name" sends them to the wrong place.
      for (const kind of c.expectKinds) {
        assert.ok(
          result.violations.some((v) => v.kind === kind),
          `${c.id}: expected a "${kind}" violation.\n${describeViolations(c.id, result)}`,
        );
      }
    });
  }

  it('the BSN case specifically: the brand passes, the invented expansion does not', () => {
    // This is the whole reason a name-only guard missed it — "BSN" is a real catalog brand.
    const result = checkFabricated(FABRICATED_REPLIES[0].reply);
    const spans = result.violations.map((v) => v.span);
    assert.ok(!spans.includes('BSN'), 'BSN is a catalog brand and must not be flagged');
    assert.ok(spans.includes('Bio-Engineered'), 'the invented backronym must be flagged');
  });
});

// ---------------------------------------------------------------------------
// The negative set: real replies must be silent
// ---------------------------------------------------------------------------

describe('RC-03 negative set: correct replies produce ZERO violations', () => {
  for (const c of GROUNDED_REPLIES) {
    it(`${c.id} — clean`, () => {
      const result = checkClaimTokenMembership({
        replyText: c.reply,
        injectedCatalogText: c.injectedCatalog,
        catalogNameIndex: c.catalogNames,
        priceSet: priceSetOf(c.injectedCatalog),
        customerText: c.customerText,
      });
      assert.deepEqual(
        result.violations,
        [],
        `${c.id} produced a FALSE POSITIVE — this is a release gate, so a false positive blocks a ` +
          `deploy.\n${describeViolations(c.id, result)}`,
      );
    });
  }

  it('the two replies the LIVE guards wrongly stripped are clean here', () => {
    // The checker must agree with the catalog, not with the alert. If these ever flag, P3-4 has
    // reintroduced RC-02 inside the very harness built to guard against it.
    for (const id of ['OK-03-the-stripped-recommendation', 'OK-04-the-stripped-price']) {
      const c = GROUNDED_REPLIES.find((x) => x.id === id);
      assert.ok(c, `${id} vanished from the corpus`);
      const result = checkClaimTokenMembership({
        replyText: c.reply,
        injectedCatalogText: c.injectedCatalog,
        catalogNameIndex: c.catalogNames,
        priceSet: priceSetOf(c.injectedCatalog),
        customerText: c.customerText,
      });
      assert.equal(result.ok, true, describeViolations(id, result));
    }
  });

  it('the negative set actually exercises the extractor (not silent because it is empty)', () => {
    const totalCandidates = GROUNDED_REPLIES.reduce(
      (sum, c) =>
        sum +
        checkClaimTokenMembership({
          replyText: c.reply,
          injectedCatalogText: c.injectedCatalog,
          catalogNameIndex: c.catalogNames,
          priceSet: priceSetOf(c.injectedCatalog),
          customerText: c.customerText,
        }).candidatesChecked,
      0,
    );
    // Two cases legitimately yield zero candidates ("Po." and an honest negative — no product
    // claims at all), so this is a corpus-level floor rather than a per-case one.
    assert.ok(totalCandidates >= 15, `only ${totalCandidates} candidates across the negative set`);
  });
});

// ---------------------------------------------------------------------------
// Anti-vacuity — three guards, per the design
// ---------------------------------------------------------------------------

describe('RC-03 anti-vacuity: the checker cannot be quietly disabled', () => {
  it('MUTATION GUARD — injecting a synthetic token into a clean reply is caught', () => {
    const c = GROUNDED_REPLIES[0];
    const base = {
      injectedCatalogText: c.injectedCatalog,
      catalogNameIndex: c.catalogNames,
      priceSet: priceSetOf(c.injectedCatalog),
      customerText: c.customerText,
    };
    assert.equal(checkClaimTokenMembership({ ...base, replyText: c.reply }).ok, true);

    const mutated = `${c.reply} Gjithashtu kemi ${MUTATION_PROBE_TOKEN} sot.`;
    const result = checkClaimTokenMembership({ ...base, replyText: mutated });
    assert.equal(result.ok, false, 'the extractor did not run over the mutated text');
    assert.ok(result.violations.some((v) => v.span === MUTATION_PROBE_TOKEN));
  });

  it('ALLOWLIST NON-DOMINANCE — no expected violation token is on the allowlist', () => {
    // Without this, a future engineer could turn a red gate green by allowlisting the very thing
    // under test, and every assertion above would keep "passing".
    const allow = new Set(TOKEN_MEMBERSHIP_ALLOWLIST.map((w) => w.toLowerCase()));
    for (const c of FABRICATED_REPLIES) {
      for (const span of c.expectViolationSpans) {
        for (const token of span.toLowerCase().split(/\s+/)) {
          assert.ok(
            !allow.has(token),
            `"${token}" (from ${c.id}) is on the allowlist — the fabrication test is now vacuous`,
          );
        }
      }
    }
  });

  it('the allowlist contains no product, brand or flavour word from any fixture catalog', () => {
    const allow = new Set(TOKEN_MEMBERSHIP_ALLOWLIST.map((w) => w.toLowerCase()));
    const catalogWords = new Set<string>();
    for (const c of GROUNDED_REPLIES) {
      for (const name of c.catalogNames) {
        for (const t of name.toLowerCase().split(/\s+/)) catalogWords.add(t);
      }
    }
    const overlap = [...catalogWords].filter((w) => allow.has(w));
    assert.deepEqual(
      overlap,
      [],
      `allowlist overlaps catalog vocabulary (${overlap.join(', ')}) — those tokens would be ` +
        'grounded by the allowlist rather than by the catalog, hiding a real fabrication',
    );
  });

  it('the corpus carries both halves, and enough of each', () => {
    assert.ok(FABRICATED_REPLIES.length >= 4, 'too few positive cases');
    assert.ok(GROUNDED_REPLIES.length >= 6, 'too few negative cases');
    // Every violation kind the checker can report has at least one positive case.
    const kinds = new Set(FABRICATED_REPLIES.flatMap((c) => c.expectKinds));
    assert.deepEqual([...kinds].sort(), ['name', 'price', 'quantity']);
  });
});
