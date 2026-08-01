/**
 * Pins `brandMembershipService.ts` — the deterministic text-lane brand verdict
 * (brand audit C2/H2). The failure classes pinned here, from the 2026-08-01 audit:
 *   - "a keni produkte nga Nike?" had NO deterministic path — the reply model
 *     guessed over catalog lines that all said `Brand: Unknown`;
 *   - a brand present only in product text (the near-empty-brand-column reality)
 *     was invisible to any brand check;
 *   - an absent verdict computed from a retrieval window (not the catalog) shipped
 *     "we don't carry X" for stocked brands (image lane, H2).
 *
 * Pure imports + injected lookups only — no database, no OpenAI client.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Product } from '../../db/models/product';
import {
  buildBrandMembershipContext,
  clearBrandMembershipCache,
  extractBrandCandidates,
  foldBrandText,
  hasBrandQuestionCue,
  isBrandCarriedInCatalog,
  resolveBrandMembershipForMessage,
} from '../brandMembershipService';
import {
  productsDeniedInReply,
  resolveBrandTokenPins,
  resolveInboundNamedProducts,
} from '../inboundNamePinning';

let seq = 0;
function product(name: string, brand: string | null = null): Product {
  seq += 1;
  return {
    id: `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`,
    tenant_id: 'tenant-1',
    name,
    brand,
    price: 50,
    discounted_price: null,
    description: null,
    usage_description: null,
    sku: null,
    category: null,
    tags: [],
    flavor: null,
    size: null,
    color: null,
    variant: null,
    weight: null,
    image_urls: [],
    is_active: true,
    in_stock: true,
    source_type: 'manual',
    extracted_text: null,
    metadata: null,
    deleted_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

const TENANT = 'tenant-1';
const nitro = product('Nitro Tech Ripped', 'Muscletech');
const optiWoman = product('Multivitamin Opti woman 60tab');

beforeEach(() => {
  clearBrandMembershipCache();
});

describe('foldBrandText', () => {
  it('folds case, diacritics, and punctuation (Unicode-aware, unlike the image-lane ASCII fold)', () => {
    assert.equal(foldBrandText('Müller '), 'muller');
    assert.equal(foldBrandText('Optimum Nutrition'), 'optimumnutrition');
    assert.equal(foldBrandText("L'Oréal"), 'loreal');
  });
});

describe('hasBrandQuestionCue', () => {
  it('fires on brand/marka and their inflections, in both languages', () => {
    assert.ok(hasBrandQuestionCue('Do you have this brand?'));
    assert.ok(hasBrandQuestionCue('a keni kete marke?'));
    assert.ok(hasBrandQuestionCue('çfarë markat keni?'));
    assert.ok(hasBrandQuestionCue('nga cila kompani vjen?'));
    assert.ok(hasBrandQuestionCue('who is the manufacturer?'));
    assert.ok(hasBrandQuestionCue('a keni produkte nga ky prodhues?'));
  });

  it('does not fire on ordinary product questions', () => {
    assert.ok(!hasBrandQuestionCue('sa kushton nitro tech ripped?'));
    assert.ok(!hasBrandQuestionCue('a keni proteina?'));
    // "market"/"marketing" must not trip the marka stem.
    assert.ok(!hasBrandQuestionCue('is there a market for this?'));
  });
});

describe('extractBrandCandidates', () => {
  it('drops question filler and generic commerce words, keeps the brand-ish tokens', () => {
    const candidates = extractBrandCandidates('a keni produkte nga Nike?');
    assert.ok(candidates.includes('nike'), candidates.join(' | '));
    assert.ok(!candidates.some((c) => /\b(keni|produkte|nga)\b/.test(c)), candidates.join(' | '));
  });

  it('emits bigrams before uni-grams so multi-word brands probe first', () => {
    const candidates = extractBrandCandidates('do you sell optimum nutrition whey?');
    const bigramIdx = candidates.indexOf('optimum nutrition');
    const uniIdx = candidates.indexOf('optimum');
    assert.ok(bigramIdx >= 0, candidates.join(' | '));
    assert.ok(uniIdx === -1 || bigramIdx < uniIdx);
  });
});

describe('resolveBrandMembershipForMessage', () => {
  it('present_brand_column: a carried brand named in ANY phrasing (no brand keyword needed)', async () => {
    const outcome = await resolveBrandMembershipForMessage(
      TENANT,
      'a keni produkte nga Muscletech?',
      {},
      {
        listBrands: async () => [{ brand: 'Muscletech', product_count: 3 }],
        byBrand: async () => [nitro],
        coverage: async () => ({ with_brand: 3, total: 10 }),
        textSearch: async () => {
          throw new Error('text probe must not run when the brand column matched');
        },
      },
    );
    assert.equal(outcome?.status, 'present_brand_column');
    assert.equal(outcome?.brand, 'Muscletech');
    assert.deepEqual(outcome?.products.map((p) => p.id), [nitro.id]);
  });

  it('matches partial brand mentions ("Optimum" → "Optimum Nutrition")', async () => {
    const outcome = await resolveBrandMembershipForMessage(
      TENANT,
      'a keni optimum?',
      {},
      {
        listBrands: async () => [{ brand: 'Optimum Nutrition', product_count: 5 }],
        byBrand: async () => [optiWoman],
        coverage: async () => ({ with_brand: 5, total: 10 }),
      },
    );
    assert.equal(outcome?.status, 'present_brand_column');
    assert.equal(outcome?.brand, 'Optimum Nutrition');
  });

  it('likely_present_text: cue + empty brand column + brand term in product text', async () => {
    const outcome = await resolveBrandMembershipForMessage(
      TENANT,
      'a e keni marken opti woman?',
      {},
      {
        listBrands: async () => [],
        byBrand: async () => [],
        coverage: async () => ({ with_brand: 0, total: 258 }),
        textSearch: async (_tenantId, term) =>
          foldBrandText(term).includes('opti') ? [optiWoman] : [],
      },
    );
    assert.equal(outcome?.status, 'likely_present_text');
    assert.deepEqual(outcome?.products.map((p) => p.id), [optiWoman.id]);
  });

  it('not_found: cue + both probes empty — and the verdict carries coverage for phrasing', async () => {
    const outcome = await resolveBrandMembershipForMessage(
      TENANT,
      'a keni produkte nga marka Zzqfakebrandix?',
      {},
      {
        listBrands: async () => [{ brand: 'Muscletech', product_count: 3 }],
        byBrand: async () => [],
        coverage: async () => ({ with_brand: 1, total: 258 }),
        textSearch: async () => [],
      },
    );
    assert.equal(outcome?.status, 'not_found');
    assert.equal(outcome?.products.length, 0);
    assert.equal(outcome?.coverage.with_brand, 1);
  });

  it('returns null for ordinary turns: no carried brand named, no brand cue', async () => {
    const outcome = await resolveBrandMembershipForMessage(
      TENANT,
      'sa kushton proteina?',
      {},
      {
        listBrands: async () => [{ brand: 'Muscletech', product_count: 3 }],
        byBrand: async () => {
          throw new Error('must not enumerate');
        },
        coverage: async () => {
          throw new Error('must not count');
        },
        textSearch: async () => {
          throw new Error('must not probe');
        },
      },
    );
    assert.equal(outcome, null);
  });

  it('the attribute-intent brand hint arms the probe even without a keyword cue', async () => {
    const outcome = await resolveBrandMembershipForMessage(
      TENANT,
      'a keni dicka nga zzqfakebrandix?',
      { attributeIntentBrand: true },
      {
        listBrands: async () => [],
        byBrand: async () => [],
        coverage: async () => ({ with_brand: 0, total: 10 }),
        textSearch: async () => [],
      },
    );
    assert.equal(outcome?.status, 'not_found');
    assert.equal(outcome?.brand, 'zzqfakebrandix');
  });

  it('anaphoric brand questions ("this brand") return null — the contextual resolver owns them', async () => {
    // Regression: before this guard, "Do you have this brand?" produced a not_found
    // verdict whose brand was the QUESTION TEXT, telling the model no product matches
    // the brand "Do you have this brand?" — over a discussed product we may well carry.
    for (const message of ['Do you have this brand?', 'a keni produkte nga kjo marka?', 'cila marke eshte kjo?']) {
      const outcome = await resolveBrandMembershipForMessage(
        TENANT,
        message,
        { attributeIntentBrand: true },
        {
          listBrands: async () => [{ brand: 'Muscletech', product_count: 3 }],
          byBrand: async () => [],
          coverage: async () => ({ with_brand: 3, total: 10 }),
          textSearch: async () => [],
        },
      );
      assert.equal(outcome, null, `expected null for anaphoric: ${message}`);
    }
  });
});

describe('isBrandCarriedInCatalog (H2 — full-catalog check for the image lane)', () => {
  it('true via the brand column, without any text probe', async () => {
    const carried = await isBrandCarriedInCatalog(TENANT, 'muscletech', {
      listBrands: async () => [{ brand: 'Muscletech', product_count: 3 }],
      textSearch: async () => {
        throw new Error('must not probe text when the column matches');
      },
    });
    assert.equal(carried, true);
  });

  it('true via tenant-wide product text when the brand column is empty', async () => {
    const carried = await isBrandCarriedInCatalog(TENANT, 'Opti', {
      listBrands: async () => [],
      textSearch: async () => [optiWoman],
    });
    assert.equal(carried, true);
  });

  it('false when neither probe matches; short brands (<3 folded chars) stay pool-judged', async () => {
    const carried = await isBrandCarriedInCatalog(TENANT, 'Zzqfakebrandix', {
      listBrands: async () => [{ brand: 'Muscletech', product_count: 3 }],
      textSearch: async () => [],
    });
    assert.equal(carried, false);
    assert.equal(
      await isBrandCarriedInCatalog(TENANT, 'ON', {
        listBrands: async () => [{ brand: 'ON', product_count: 1 }],
        textSearch: async () => {
          throw new Error('must not probe for a 2-char brand');
        },
      }),
      false,
    );
  });
});

describe('buildBrandMembershipContext', () => {
  const coverageHigh = { with_brand: 200, total: 258 };
  const coverageLow = { with_brand: 1, total: 258 };

  it('present: confirms the brand by name and carries the brand accuracy rules', () => {
    const text = buildBrandMembershipContext({
      status: 'present_brand_column',
      brand: 'Muscletech',
      products: [nitro],
      coverage: coverageHigh,
    });
    assert.match(text, /CONTAINS products from the brand "Muscletech"/);
    assert.match(text, /A different brand of the same product type is NOT the requested brand/);
  });

  it('not_found + populated column: honest denial with different-brand alternatives allowed', () => {
    const text = buildBrandMembershipContext({
      status: 'not_found',
      brand: 'nike',
      products: [],
      coverage: coverageHigh,
    });
    assert.match(text, /does not appear to carry it/);
    assert.match(text, /clearly as different brands/);
  });

  it('not_found + near-empty column: refuses to confirm but does NOT firmly deny', () => {
    const text = buildBrandMembershipContext({
      status: 'not_found',
      brand: 'nike',
      products: [],
      coverage: coverageLow,
    });
    assert.match(text, /brand labels are largely missing/);
    assert.match(text, /Do NOT confirm carrying this brand/);
    assert.match(text, /do not firmly deny it either/);
  });
});

// ---------------------------------------------------------------------------
// Audit H1 — brand-aware inbound pinning + brand-level denial backstop
// ---------------------------------------------------------------------------

describe('resolveBrandTokenPins (H1 — short brands the gram floor cannot reach)', () => {
  const airMax = product('Air Max 90', 'Nike');
  const gncFish = product('Fish Oil 100caps', 'GNC');

  it('pins products for a 4-char brand ("Nike") via exact folded equality', async () => {
    const pins = await resolveBrandTokenPins(TENANT, 'A keni Nike?', {
      carriedBrands: async () => [
        { brand: 'Nike', product_count: 2 },
        { brand: 'GNC', product_count: 1 },
      ],
      byBrand: async (_tenantId, brand) => (brand === 'Nike' ? [airMax] : [gncFish]),
    });
    assert.deepEqual(pins.map((p) => p.id), [airMax.id]);
  });

  it('pins products for a 3-char brand ("GNC") — structurally unpinnable before H1', async () => {
    const pins = await resolveBrandTokenPins(TENANT, 'a keni produkte nga gnc?', {
      carriedBrands: async () => [{ brand: 'GNC', product_count: 1 }],
      byBrand: async () => [gncFish],
    });
    assert.deepEqual(pins.map((p) => p.id), [gncFish.id]);
  });

  it('pins nothing when no carried brand is mentioned (genuine denials stay untouched)', async () => {
    const pins = await resolveBrandTokenPins(TENANT, 'A keni Adidas?', {
      carriedBrands: async () => [{ brand: 'Nike', product_count: 2 }],
      byBrand: async () => {
        throw new Error('must not enumerate an unmatched brand');
      },
    });
    assert.deepEqual(pins, []);
  });

  it('never throws — [] on a failing lookup', async () => {
    const pins = await resolveBrandTokenPins(TENANT, 'A keni Nike?', {
      carriedBrands: async () => {
        throw new Error('db down');
      },
    });
    assert.deepEqual(pins, []);
  });
});

describe('resolveInboundNamedProducts with the brand pass (H1)', () => {
  const airMax = product('Air Max 90', 'Nike');

  it('a message naming only a short brand still pins that brand\'s products', async () => {
    const pinned = await resolveInboundNamedProducts(TENANT, 'A keni Nike?', {
      bySubstring: async () => [],
      bySimilarity: async () => [],
      carriedBrands: async () => [{ brand: 'Nike', product_count: 1 }],
      byBrand: async () => [airMax],
    });
    assert.deepEqual(pinned.map((p) => p.id), [airMax.id]);
  });
});

describe('productsDeniedInReply — brand-level denial (H1)', () => {
  const airMax = product('Air Max 90', 'Nike');

  it('a denial clause naming only the BRAND counts the pinned product as denied', () => {
    const denied = productsDeniedInReply([airMax], 'Nuk kemi produkte nga Nike.');
    assert.deepEqual(denied.map((p) => p.id), [airMax.id]);
  });

  it('clause scoping holds: denial of another brand + offer of the pinned brand does not trip', () => {
    const denied = productsDeniedInReply(
      [airMax],
      'Adidas nuk e kemi, por ju sugjerojme Air Max 90 nga Nike.',
    );
    assert.deepEqual(denied, []);
  });

  it('brandless products keep the exact pre-H1 behavior', () => {
    const plain = product('Carbo one 1kg Limon');
    assert.deepEqual(productsDeniedInReply([plain], 'Nuk kemi produkte nga Nike.'), []);
  });
});