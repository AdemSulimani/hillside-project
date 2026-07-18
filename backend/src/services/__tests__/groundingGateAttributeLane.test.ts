/**
 * P3-1 — the declared-attribute grounding lane, end to end through `evaluateConsolidatedGrounding`.
 *
 * The gap this closes (docs/audit/16-remediation-plan.md §P3-1): the `facts_used` contract already
 * asked the model to declare attribute claims, but the gate consumed only `f.type === 'name'` and
 * dropped the rest — leaving a live fabrication class, "a false SENTENCE built from true WORDS".
 *
 * Kept in its own file rather than appended to `groundingGate.test.ts` so the P2-1 acceptance
 * surface (EV-011/013/015, fcd0af7e, the price/name backstops) stays exactly as it was and any
 * regression there is unambiguous about which item caused it.
 *
 * Evidence fixtures are REAL text from the dev catalog (tenant 02beb134), cited by product name.
 * Runs fully in-process: the gate takes its catalog collaborators as injected `deps`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateConsolidatedGrounding, type GroundingGateDeps } from '../groundingGate';
import {
  buildPriceSetFromCatalogRows,
  verifySuspectedNamesAgainstCatalog,
} from '../catalogGuardReferenceService';
import { resolveProductRef } from '../catalogAttributeReferenceService';
import { segmentClauses } from '../attributeClaimLexicon';
import type { CatalogAttributeIndex, CatalogAttributeRow } from '../attributeGrounding';
import { normalizeText } from '../productTitleNormalization';
import type { SimilarProductName } from '../../db/models/product';

const TENANT = '00000000-0000-0000-0000-000000000001';

/** Locate `backend/src` by walking up from the cwd (tsx transpiles to CJS — no import.meta). */
function findSrcDir(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'src');
    if (existsSync(path.join(candidate, 'services', 'aiService.ts'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not locate backend/src from cwd ${process.cwd()}`);
}

const PRICE_SET = buildPriceSetFromCatalogRows([
  { price: '55.00', discounted_price: null }, // Mega mass 3kg Vanil
  { price: '18.00', discounted_price: null }, // Carbo One 1kg Orange
]);
const NAME_INDEX = ['Mega mass 3kg Vanil', 'Mega mass 7kg Qokolad', 'Carbo One 1kg Orange'];

const missLookup = async (
  _t: string,
  _c: string,
  _m: number,
): Promise<SimilarProductName | null> => null;

/** `Mega mass 3kg Vanil` — REFUTES "pa sheqer": "Sheqer i reduktuar ... më e ulët në sheqer". */
const ATTR_MEGA_MASS =
  'Sheqer i reduktuar: Formula përmban karbohidrate komplekse dhe është më e ulët në sheqer ' +
  'krahasuar me formulën e vjetër.';
/** `Carbo One 1kg Orange` — genuinely SILENT on sugar. */
const ATTR_CARBO = 'Karbohidrate me cilësi të lartë për rimbushjen e glikogjenit pas stërvitjes.';

function mkRow(id: string, name: string, freeText: string): CatalogAttributeRow {
  return {
    id,
    name,
    normName: normalizeText(name),
    clauses: segmentClauses([name, 'Kategori', freeText].filter(Boolean).join('\n')),
    populated: freeText.length > 0,
  };
}

function attrIndex(truncated = false): CatalogAttributeIndex {
  return {
    rows: [
      mkRow('1', 'Mega mass 3kg Vanil', ATTR_MEGA_MASS),
      mkRow('2', 'Mega mass 7kg Qokolad', ATTR_MEGA_MASS),
      mkRow('3', 'Carbo One 1kg Orange', ATTR_CARBO),
    ],
    truncated,
  };
}

/** Legacy 4-property deps — no attribute lane at all. */
function legacyDeps(overrides: Partial<GroundingGateDeps> = {}): GroundingGateDeps {
  return {
    getPriceSet: overrides.getPriceSet ?? (async () => PRICE_SET),
    getNameIndex: overrides.getNameIndex ?? (async () => NAME_INDEX),
    suspectNames:
      overrides.suspectNames ?? (async () => ({ hasHallucination: false, suspectedNames: [] })),
    verifyNames:
      overrides.verifyNames ??
      ((t, s, index) => verifySuspectedNamesAgainstCatalog(t, s, index, missLookup)),
  };
}

/** Deps WITH the attribute lane wired, using the REAL resolver over an in-memory index. */
function attrDeps(
  overrides: Partial<GroundingGateDeps> & { index?: CatalogAttributeIndex } = {},
): GroundingGateDeps {
  const index = overrides.index ?? attrIndex();
  return {
    ...legacyDeps(overrides),
    getAttributeIndex: overrides.getAttributeIndex ?? (async () => index),
    resolveProductRef:
      overrides.resolveProductRef ?? ((t, ref, idx) => resolveProductRef(t, ref, idx, missLookup)),
  };
}

const BASE = { tenantId: TENANT, nameLlmCap: 150, stripFloor: 24 };
const MEGA_FACT = {
  type: 'attribute' as const,
  product_ref: 'Mega mass 3kg Vanil',
  value: 'pa sheqer',
};

// ---------------------------------------------------------------------------

describe('P3-1 attribute lane — acceptance', () => {
  it("ENFORCE: the roadmap's own example is caught and never reaches the customer", async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps(),
      attributeMode: 'enforce',
      attributeMaxClaims: 8,
    });
    assert.equal(v.escalate, true);
    assert.equal(v.reason, 'hallucinated_product_attribute');
    assert.equal(v.ungroundedAttributes?.length, 1);
    assert.equal(v.ungroundedAttributes?.[0].support, 'contradicted');
    assert.equal(v.ungroundedAttributes?.[0].scope, 'product');
    assert.equal(v.ungroundedAttributes?.[0].matchedProduct, 'Mega mass 3kg Vanil');
  });

  it('ENFORCE: targeted strip keeps the grounded sentence, removes only the refuted one', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose:
        'Carbo One 1kg Orange kushton €18.00 dhe eshte shume i mire per rikuperim pas stervitjes. Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps(),
      attributeMode: 'enforce',
    });
    assert.equal(v.status, 'stripped');
    assert.match(v.text, /18\.00/);
    assert.doesNotMatch(v.text.toLowerCase(), /pa sheqer/);
  });

  it('SHADOW: identical judgement, reply untouched — a bake-in predicts the cutover exactly', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps(),
      attributeMode: 'shadow',
    });
    assert.equal(v.status, 'grounded');
    assert.equal(v.escalate, false);
    assert.equal(v.shadowAttributes?.length, 1);
    assert.equal(v.shadowAttributes?.[0].support, 'contradicted');
  });

  it('determinism: 20 identical runs yield an identical verdict', async () => {
    const run = () =>
      evaluateConsolidatedGrounding({
        ...BASE,
        prose: 'Mega mass 3kg Vanil është pa sheqer.',
        factsUsed: [MEGA_FACT],
        deps: attrDeps(),
        attributeMode: 'enforce',
      });
    const first = JSON.stringify(await run());
    for (let i = 0; i < 20; i += 1) assert.equal(JSON.stringify(await run()), first);
  });
});

describe('P3-1 attribute lane — flag-off byte identity', () => {
  const input = {
    ...BASE,
    prose: 'Mega mass 3kg Vanil është pa sheqer.',
    factsUsed: [MEGA_FACT],
  };

  it('mode off deep-equals the legacy verdict AND omits the new keys entirely', async () => {
    const legacy = await evaluateConsolidatedGrounding({ ...input, deps: legacyDeps() });
    const off = await evaluateConsolidatedGrounding({
      ...input,
      deps: attrDeps(),
      attributeMode: 'off',
    });
    assert.deepEqual(off, legacy);
    // OMITTED, never `[]`: groundingGateDetails is persisted verbatim into ai_alerts.details
    // JSONB, so an unconditional empty array would change every flag-off escalation record.
    assert.equal('ungroundedAttributes' in off, false);
    assert.equal('shadowAttributes' in off, false);
  });

  it('an absent dep disables the lane, so pre-existing 4-property deps keep their behaviour', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...input,
      deps: legacyDeps(),
      attributeMode: 'enforce',
    });
    assert.equal(v.escalate, false);
    assert.equal('ungroundedAttributes' in v, false);
  });

  it('mode off performs ZERO index reads and ZERO ref resolutions', async () => {
    let indexCalls = 0;
    let resolveCalls = 0;
    await evaluateConsolidatedGrounding({
      ...input,
      deps: attrDeps({
        getAttributeIndex: async () => {
          indexCalls += 1;
          return attrIndex();
        },
        resolveProductRef: async (t, ref, idx) => {
          resolveCalls += 1;
          return resolveProductRef(t, ref, idx, missLookup);
        },
      }),
      attributeMode: 'off',
    });
    assert.equal(indexCalls, 0);
    assert.equal(resolveCalls, 0);
  });

  it('LAZY: no index read when nothing eligible was declared, even at enforce', async () => {
    let indexCalls = 0;
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Kemi Carbo One 1kg Orange për €18.00.',
      // A flavour and a weight can never reach the flag branch — eligibility is the firewall.
      factsUsed: [
        { type: 'attribute', product_ref: 'Carbo One 1kg Orange', value: 'shije portokall' },
        { type: 'attribute', product_ref: 'Carbo One 1kg Orange', value: '1kg' },
      ],
      deps: attrDeps({
        getAttributeIndex: async () => {
          indexCalls += 1;
          return attrIndex();
        },
      }),
      attributeMode: 'enforce',
    });
    assert.equal(indexCalls, 0, 'the vast majority of turns must cost zero attribute I/O');
    assert.equal(v.status, 'grounded');
  });

  it('a declared claim absent from the prose is never judged', async () => {
    let indexCalls = 0;
    await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Çmimi është €18.00.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps({
        getAttributeIndex: async () => {
          indexCalls += 1;
          return attrIndex();
        },
      }),
      attributeMode: 'enforce',
    });
    assert.equal(indexCalls, 0);
  });

  it('maxClaims 0 is an in-incident kill switch that judges nothing', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...input,
      deps: attrDeps(),
      attributeMode: 'enforce',
      attributeMaxClaims: 0,
    });
    assert.equal(v.escalate, false);
    assert.equal('ungroundedAttributes' in v, false);
  });
});

describe('P3-1 attribute lane — false-positive controls', () => {
  it('AMBIGUOUS ref resolves to tenant scope and can never contradict', async () => {
    // "Mega mass" matches both the 3kg and 7kg rows; picking one would judge the claim against a
    // sibling whose composition may genuinely differ.
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass është pa sheqer.',
      factsUsed: [{ type: 'attribute', product_ref: 'Mega mass', value: 'pa sheqer' }],
      deps: attrDeps(),
      attributeMode: 'enforce',
    });
    assert.equal(v.escalate, false);
    assert.equal(v.status, 'grounded');
  });

  it('UNRESOLVED ref falls back to tenant scope — rescue-only, never a flag', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Produkti është pa sheqer.',
      factsUsed: [
        { type: 'attribute', product_ref: 'Nje Produkt Qe Nuk Ekziston Fare', value: 'pa sheqer' },
      ],
      deps: attrDeps(),
      attributeMode: 'enforce',
    });
    assert.equal(v.escalate, false);
  });

  it('TRUNCATED index disables contradiction entirely', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps({ index: attrIndex(true) }),
      attributeMode: 'enforce',
    });
    assert.equal(v.escalate, false);
  });

  it('a SILENT row is passed, not flagged (218/257 real rows are in this class)', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Carbo One 1kg Orange është pa sheqer.',
      factsUsed: [{ type: 'attribute', product_ref: 'Carbo One 1kg Orange', value: 'pa sheqer' }],
      deps: attrDeps(),
      attributeMode: 'enforce',
    });
    assert.equal(v.escalate, false);
    assert.equal(v.status, 'grounded');
  });

  it('STRIP SCOPE (the fcd0af7e invariant): a correct claim about ANOTHER product survives', async () => {
    // Both sentences fold to contain "pa sheqer". A phrase-only strip would delete the true one
    // too — the blanket-replace pathology this gate exists to prevent, one dimension down.
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose:
        'Carbo One 1kg Orange është pa sheqer dhe kushton €18.00 per pakon. Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps(),
      attributeMode: 'enforce',
    });
    assert.equal(v.status, 'stripped');
    assert.match(v.text, /Carbo One 1kg Orange është pa sheqer/);
    assert.doesNotMatch(v.text, /Mega mass/);
  });

  it('an unexcisable claim ESCALATES rather than shipping the remainder', async () => {
    // The claim and its product never co-occur in one sentence, so no surgical strip exists. We
    // know a refuted claim is in the text, so sending what is left is not an option.
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass 3kg Vanil eshte nje mass gainer i shkelqyer per shtim peshe. Po, është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps(),
      attributeMode: 'enforce',
    });
    assert.equal(v.escalate, true);
    assert.equal(v.reason, 'hallucinated_product_attribute');
  });
});

describe('P3-1 attribute lane — the fail policy is deliberately ASYMMETRIC', () => {
  it('attribute index failure fails OPEN — identical to mode off, NOT infra_error', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps({
        getAttributeIndex: async () => {
          throw new Error('redis down');
        },
      }),
      attributeMode: 'enforce',
    });
    assert.equal(v.status, 'grounded');
    assert.equal(v.escalate, false);
  });

  it('ref resolution failure declines to tenant scope rather than flagging', async () => {
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [MEGA_FACT],
      deps: attrDeps({
        resolveProductRef: async () => {
          throw new Error('pg down');
        },
      }),
      attributeMode: 'enforce',
    });
    assert.equal(v.escalate, false);
  });

  it('the PRICE/NAME index still fails CLOSED — do not "harmonise" the asymmetry away', async () => {
    // The price/name reference sets are structurally complete and proven, so their unavailability
    // genuinely means "cannot validate". The attribute lane is new, judges free prose, and can
    // only ADD flags — so it must never pause a conversation on infrastructure noise.
    const v = await evaluateConsolidatedGrounding({
      ...BASE,
      prose: 'Mega mass 3kg Vanil është pa sheqer.',
      factsUsed: [],
      deps: attrDeps({
        getPriceSet: async () => {
          throw new Error('redis down');
        },
      }),
      attributeMode: 'enforce',
    });
    assert.equal(v.status, 'infra_error');
    assert.equal(v.reason, 'grounding_check_unavailable');
    assert.equal(v.failClosed, true);
  });
});

describe('P3-1 — the gap cannot be silently un-closed (inverse tripwire)', () => {
  /**
   * Replaces the P3-4 tripwire in `eval/harness/__tests__/tokenMembership.test.ts`, which asserted
   * `f.type === 'attribute'` was ABSENT from the gate and was deleted when this lane landed.
   *
   * Inverted here so the invariant is guarded in BOTH directions. A source-text assertion is the
   * only thing that catches a refactor quietly dropping either filter — a unit test over behaviour
   * would keep passing against a lane that is no longer reached.
   */
  it('the gate consumes BOTH declared name facts and declared attribute facts', () => {
    const source = readFileSync(
      path.join(findSrcDir(), 'services', 'groundingGate.ts'),
      'utf8',
    );
    assert.match(
      source,
      /f\.type === 'name'/,
      'the gate no longer filters declared NAME facts — RC-02 name grounding may have regressed',
    );
    assert.match(
      source,
      /f\.type === 'attribute'/,
      'the gate no longer consumes declared ATTRIBUTE facts — P3-1 has been reverted and the ' +
        '"false sentence built from true words" class is unguarded on the send path again',
    );
  });
});
