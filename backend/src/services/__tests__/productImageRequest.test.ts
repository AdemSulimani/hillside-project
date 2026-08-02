/**
 * Pins the deterministic core of the product photo-request flow
 * (`productImageRequestService.ts`) against the two live bugs it fixes (2026-07-20):
 *
 *  Bug #1 — a bare "foto produktet" resolved to the ENTIRE 10-row retrieval-fusion pool and
 *  the missing-photo notice enumerated 9 product names the customer never asked about
 *  (conversation 9e84a4ee). Broad refs must scope to products actually NAMED in recent AI
 *  replies, be capped, and the notice must never enumerate past the cap.
 *
 *  Bug #2 — Gheg-inflected named refs ("nitro techin", "carbo limonin") matched nothing
 *  (exact/substring only), the pipeline silently fell through, and the raw model reply
 *  shipped an improvised "we can't send photos" apology despite the catalog holding an image
 *  (conversation 21288070). Token-stem matching must bridge the inflection, and zero targets
 *  must route to `holding_unresolved` — never to the raw reply.
 *
 * Everything under test is pure (catalog lookups are injected), so this suite runs with no
 * database and no OpenAI key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Product } from '../../db/models/product';
import {
  albanianTokenStems,
  productNameTokenMatch,
  filterProductsMentionedInTexts,
  resolveProductsForImageRequest,
  augmentImageTargetsFromCatalog,
  decideImageRequestOutcome,
  buildImageReplyText,
  type ProductImageRef,
} from '../productImageRequestService';
import { isCannedHoldingCopy, IMAGE_REPLY_TEMPLATES } from '../cannedReplyText';

let seq = 0;
function product(name: string, imageCount = 0): Product {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tenant_id: 'tenant-1',
    name,
    brand: null,
    price: 10,
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
    image_urls: Array.from({ length: imageCount }, (_, i) => `https://img.example/${seq}/${i}.jpg`),
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

const name = (r: { type: ProductImageRef['type']; value?: string | null }): ProductImageRef =>
  ({ type: r.type, value: r.value ?? null });

describe('albanianTokenStems', () => {
  it('strips the definite/accusative endings seen in live traffic', () => {
    assert.ok(albanianTokenStems('techin').includes('tech'));
    assert.ok(albanianTokenStems('limonin').includes('limon'));
    assert.ok(albanianTokenStems('techit').includes('tech'));
  });

  it('always returns the raw token first', () => {
    assert.equal(albanianTokenStems('techin')[0], 'techin');
    assert.deepEqual(albanianTokenStems('xyz'), ['xyz']);
  });

  it('never strips below a 3-char stem', () => {
    // "keks" ends with no suffix; "min" ends with "in"/"n" but the stems would be 1-2 chars.
    assert.deepEqual(albanianTokenStems('keks'), ['keks']);
    assert.deepEqual(albanianTokenStems('min'), ['min']);
    // "ana" ends with "a" but the stem "an" (2 chars) is below the floor — not stripped.
    assert.deepEqual(albanianTokenStems('ana'), ['ana']);
  });
});

describe('productNameTokenMatch', () => {
  it('bridges the live Bug #2 pairs that substring matching cannot', () => {
    assert.equal(productNameTokenMatch('nitro techin', 'Nitro Tech Ripped'), true);
    assert.equal(productNameTokenMatch('carbo limonin', 'Carbo one 1kg Limon'), true);
    assert.equal(productNameTokenMatch('nitro techit', 'Nitro-tech 1.8kg Dredhz'), true);
  });

  it('rejects names that do not carry every reference token', () => {
    assert.equal(productNameTokenMatch('carbo limonin', 'Carbo One 1kg Orange'), false);
    assert.equal(productNameTokenMatch('nitro techin', 'Cell Tech 1.13 kg Fruit'), false);
    assert.equal(productNameTokenMatch('whey gold', 'Platinum 100% Creatine 200gr'), false);
  });

  it('is diacritic- and punctuation-insensitive', () => {
    assert.equal(productNameTokenMatch('proteinë whey', 'Protein Whey Gold 2.2kg'), true);
    assert.equal(productNameTokenMatch('nitro-techin', 'Nitro Tech Ripped'), true);
  });

  it('returns false for empty or too-short references', () => {
    assert.equal(productNameTokenMatch('', 'Nitro Tech Ripped'), false);
    assert.equal(productNameTokenMatch('a', 'Nitro Tech Ripped'), false);
  });
});

describe('filterProductsMentionedInTexts', () => {
  const pool = [
    product('Nitro Tech Ripped', 1),
    product('Carbo one 1kg Limon'),
    product('Carbo One 1kg Orange'),
    product('Nitro Tech 1.8kg  Keks'),
    product('Hydroxycut Hardcore Super Elite100tab'),
  ];

  it('selects only the products actually named in the texts (Tier A)', () => {
    const texts = ['Po, kemi në dispozicion Nitro Tech Ripped me çmim të mirë.'];
    const mentioned = filterProductsMentionedInTexts(pool, texts);
    assert.deepEqual(mentioned.map((p) => p.name), ['Nitro Tech Ripped']);
  });

  it('catches family-level mentions via the leading-token tier (Tier B), ranked after Tier A', () => {
    const texts = ['Po, kemi Nitro Tech Ripped dhe Carbo One në shije limon dhe portokall.'];
    const mentioned = filterProductsMentionedInTexts(pool, texts);
    // Tier A: full name "Nitro Tech Ripped". Tier B: "carbo one" lead matches both Carbo
    // variants; "nitro tech" lead also matches the Keks sibling. What it must NOT contain
    // is anything never written out (Hydroxycut).
    assert.equal(mentioned[0].name, 'Nitro Tech Ripped');
    assert.ok(mentioned.some((p) => p.name === 'Carbo one 1kg Limon'));
    assert.ok(!mentioned.some((p) => p.name.startsWith('Hydroxycut')));
  });

  it('returns empty for empty texts', () => {
    assert.deepEqual(filterProductsMentionedInTexts(pool, []), []);
    assert.deepEqual(filterProductsMentionedInTexts(pool, ['']), []);
  });

  it('catches a bare code-token family mention ("C4") via Tier C', () => {
    const c4Pool = [
      product('C4 Ripped pre-workout 30servime Ananas'),
      product('C4 Original 30servime shije Mjedre'),
      product('Nitro Tech Ripped', 1),
    ];
    const mentioned = filterProductsMentionedInTexts(c4Pool, ['Nuk e kemi C4 në dispozicion.']);
    assert.deepEqual(
      mentioned.map((p) => p.name).sort(),
      ['C4 Original 30servime shije Mjedre', 'C4 Ripped pre-workout 30servime Ananas'],
    );
  });

  it('Tier C stays silent when a fuller mention resolved the code-token family', () => {
    const c4Pool = [
      product('C4 Ripped pre-workout 30servime Ananas'),
      product('C4 Original 30servime shije Mjedre'),
    ];
    // "C4 Ripped" (Tier B lead) is written out — the embedded "c4" must not drag in C4 Original.
    const mentioned = filterProductsMentionedInTexts(c4Pool, ['Po, kemi C4 Ripped me çmim €38.']);
    assert.deepEqual(mentioned.map((p) => p.name), ['C4 Ripped pre-workout 30servime Ananas']);
  });
});

describe('resolveProductsForImageRequest', () => {
  // The live Bug #1 pool shape: 10 fused products, one imaged, two actually discussed.
  const nitroRipped = product('Nitro Tech Ripped', 1);
  const carboLimon = product('Carbo one 1kg Limon');
  const noisePool = [
    product('Nitro Tech 1.8kg  Keks'),
    product('Carbo One 1kg Orange'),
    product('Nitro-tech 1.8kg Dredhz'),
    product('Nitro-tech 100% whey Gold 2.2kg Cookies cream'),
    product('Nitro-tech 100% whey Gold 2.2kg Double rich Qokolad'),
    product('Cell Tech 1.13 kg Fruit'),
    product('Hydroxycut Hardcore Super Elite100tab'),
    product('Platinum 100% Creatine 200gr'),
  ];
  const fullPool = [nitroRipped, carboLimon, ...noisePool];
  const aiTexts = ['Po, kemi në dispozicion Nitro Tech Ripped dhe Carbo one 1kg Limon.'];

  it('Bug #1 replay: "all" scopes to the discussed products, never the whole pool', () => {
    const { targets, trace } = resolveProductsForImageRequest(
      [name({ type: 'all' })],
      [],
      fullPool,
      aiTexts,
    );
    assert.deepEqual(
      targets.map((p) => p.name).sort(),
      ['Carbo one 1kg Limon', 'Nitro Tech Ripped'],
    );
    assert.equal(trace.discussedCount, 2);
    assert.ok(targets.length <= 3);
  });

  it('"all" with no discussion evidence degrades to the single top product', () => {
    const { targets, trace } = resolveProductsForImageRequest(
      [name({ type: 'all' })],
      [],
      fullPool,
      [],
    );
    assert.equal(targets.length, 1);
    assert.equal(targets[0].id, fullPool[0].id);
    assert.equal(trace.matches[0].method, 'fallback_top');
  });

  it('enforces the target cap and reports it in the trace', () => {
    const many = ['A', 'B', 'C', 'D', 'E'].map((n) => product(`Product ${n}`));
    const texts = ['Kemi Product A, Product B, Product C, Product D dhe Product E.'];
    const { targets, trace } = resolveProductsForImageRequest(
      [name({ type: 'all' })],
      [],
      many,
      texts,
      3,
    );
    assert.equal(targets.length, 3);
    assert.equal(trace.capped, true);
    assert.equal(trace.matches.length, 3);
  });

  it('"current" prefers the most recently discussed product over the raw pool head', () => {
    const { targets } = resolveProductsForImageRequest(
      [name({ type: 'current' })],
      [],
      fullPool,
      ['Carbo one 1kg Limon është zgjidhje e mirë.'],
    );
    assert.equal(targets[0].id, carboLimon.id);
  });

  it('positional refs index the discussed list the customer actually saw', () => {
    const { targets } = resolveProductsForImageRequest(
      [name({ type: 'position', value: '2' })],
      fullPool,
      [],
      aiTexts,
    );
    assert.equal(targets[0].id, carboLimon.id);
  });

  it('Bug #2 replay: inflected Gheg names resolve via the token tier', () => {
    const { targets, trace } = resolveProductsForImageRequest(
      [name({ type: 'name', value: 'nitro techin' }), name({ type: 'name', value: 'carbo limonin' })],
      fullPool,
      [],
      [],
    );
    assert.deepEqual(
      targets.map((p) => p.name).sort(),
      ['Carbo one 1kg Limon', 'Nitro Tech Ripped'],
    );
    assert.deepEqual(trace.matches.map((m) => m.method), ['token', 'token']);
  });

  it('token tier prefers the variant that has an image', () => {
    // "nitro techin" token-matches every Nitro Tech variant; the imaged one must win.
    const { targets } = resolveProductsForImageRequest(
      [name({ type: 'name', value: 'nitro techin' })],
      [...noisePool, nitroRipped],
      [],
      [],
    );
    assert.equal(targets[0].id, nitroRipped.id);
  });

  it('keeps the pinned exact/substring behavior including imaged-duplicate preference', () => {
    const dupNoImage = product('Beast Pre-Workout');
    const dupImaged = product('Beast Pre-Workout', 2);
    const { targets, trace } = resolveProductsForImageRequest(
      [name({ type: 'name', value: 'beast pre-workout' })],
      [dupNoImage, dupImaged],
      [],
      [],
    );
    assert.equal(targets[0].id, dupImaged.id);
    assert.equal(trace.matches[0].method, 'exact');
  });

  it('a specific ref that matches nothing yields ZERO targets — no unrelated substitute', () => {
    const { targets } = resolveProductsForImageRequest(
      [name({ type: 'name', value: 'krem dielli xyz' })],
      fullPool,
      [],
      aiTexts,
    );
    assert.deepEqual(targets, []);
  });

  it('a generic request with no refs falls back to the top context product', () => {
    const { targets, trace } = resolveProductsForImageRequest([], [], fullPool, []);
    assert.equal(targets.length, 1);
    assert.equal(trace.matches[0].method, 'fallback_top');
  });

  it('deduplicates across refs', () => {
    const { targets } = resolveProductsForImageRequest(
      [
        name({ type: 'name', value: 'nitro tech ripped' }),
        name({ type: 'name', value: 'nitro techin' }),
      ],
      fullPool,
      [],
      [],
    );
    assert.equal(targets.filter((p) => p.id === nitroRipped.id).length, 1);
  });
});

describe('augmentImageTargetsFromCatalog', () => {
  const imagedRipped = product('Nitro Tech Ripped', 1);

  it('recovers an inflected named request via the stemmed-token rung', async () => {
    const calls: string[] = [];
    const result = await augmentImageTargetsFromCatalog(
      'tenant-1',
      [name({ type: 'name', value: 'nitro techin' })],
      [],
      {
        bySubstring: async (_t, term) => {
          calls.push(term);
          // Raw "%nitro techin%" misses; the stemmed "%tech%" (or "%techi%") rung hits.
          return term.toLowerCase().includes('tech') && !term.includes(' ')
            ? [imagedRipped, product('Cell Tech 1.13 kg Fruit', 1)]
            : [];
        },
        bySimilarity: async () => [],
      },
    );
    assert.deepEqual(result.map((p) => p.id), [imagedRipped.id]);
    assert.ok(calls.length >= 2, `expected raw + stemmed lookups, got: ${calls.join(', ')}`);
  });

  it('falls back to the trigram rung when substring rungs miss', async () => {
    const result = await augmentImageTargetsFromCatalog(
      'tenant-1',
      [name({ type: 'name', value: 'nitro tek riped' })],
      [],
      {
        bySubstring: async () => [],
        bySimilarity: async () => [imagedRipped],
      },
    );
    assert.deepEqual(result.map((p) => p.id), [imagedRipped.id]);
  });

  it('is satisfied by an existing imaged target even when only token-matched (no duplicates)', async () => {
    let lookups = 0;
    const result = await augmentImageTargetsFromCatalog(
      'tenant-1',
      [name({ type: 'name', value: 'nitro techin' })],
      [imagedRipped],
      {
        bySubstring: async () => {
          lookups += 1;
          return [];
        },
        bySimilarity: async () => {
          lookups += 1;
          return [];
        },
      },
    );
    assert.deepEqual(result.map((p) => p.id), [imagedRipped.id]);
    assert.equal(lookups, 0);
  });

  it('replaces an imageless sibling chosen for the same named request', async () => {
    const imagelessSibling = product('Nitro Tech 1.8kg  Keks');
    const result = await augmentImageTargetsFromCatalog(
      'tenant-1',
      [name({ type: 'name', value: 'nitro tech' })],
      [imagelessSibling],
      {
        bySubstring: async () => [imagedRipped],
        bySimilarity: async () => [],
      },
    );
    assert.deepEqual(result.map((p) => p.id), [imagedRipped.id]);
  });

  it('surfaces an imageless catalog match when the ref is missing from context (live gap: carbo limonin)', async () => {
    // Cold conversation: retrieval pool had NO carbo product, so the context resolver
    // produced nothing for "carbo limonin". The catalog holds only an imageless row —
    // it must become a target so the missing-photo notice + alert name it, instead of
    // the request silently vanishing from the reply.
    const carboNoImage = product('Carbo one 1kg Limon');
    const noise = product('Amino rest 500gr Qershi&Limonad');
    const result = await augmentImageTargetsFromCatalog(
      'tenant-1',
      [name({ type: 'name', value: 'carbo limonin' })],
      [],
      {
        // Raw "%carbo limonin%" misses; stemmed "%limon%" returns both rows, and the
        // token filter must keep only the genuine carbo match.
        bySubstring: async (_t, term) =>
          term.toLowerCase() === 'limon' ? [carboNoImage, noise] : [],
        bySimilarity: async () => [],
      },
    );
    assert.deepEqual(result.map((p) => p.id), [carboNoImage.id]);
    const d = decideImageRequestOutcome(result);
    assert.equal(d.outcome, 'holding_missing_images');
  });

  it('leaves targets untouched when the catalog genuinely has no imaged row', async () => {
    const imageless = product('Beast pre-workout 30servime Mango');
    const result = await augmentImageTargetsFromCatalog(
      'tenant-1',
      [name({ type: 'name', value: 'beast pre-workout' })],
      [imageless],
      { bySubstring: async () => [imageless], bySimilarity: async () => [] },
    );
    assert.deepEqual(result.map((p) => p.id), [imageless.id]);
  });

  it('never throws on lookup failure — targets pass through unchanged', async () => {
    const target = product('Nitro Tech Ripped');
    const result = await augmentImageTargetsFromCatalog(
      'tenant-1',
      [name({ type: 'name', value: 'nitro tech' })],
      [target],
      {
        bySubstring: async () => {
          throw new Error('db down');
        },
        bySimilarity: async () => {
          throw new Error('db down');
        },
      },
    );
    assert.deepEqual(result.map((p) => p.id), [target.id]);
  });
});

describe('decideImageRequestOutcome + buildImageReplyText', () => {
  const imaged = product('Nitro Tech Ripped', 1);
  const imaged2 = product('Cell Tech 1.13 kg Fruit', 1);
  const missing = product('Carbo one 1kg Limon');

  it('routes zero targets to holding_unresolved (the raw model reply must never ship)', () => {
    const d = decideImageRequestOutcome([]);
    assert.equal(d.outcome, 'holding_unresolved');
    assert.equal(buildImageReplyText('sq', d.withImages, d.missingImages),
      IMAGE_REPLY_TEMPLATES.sq.unresolvedHolding);
  });

  it('routes all-imageless targets to holding_missing_images with the generic holding line', () => {
    const d = decideImageRequestOutcome([missing]);
    assert.equal(d.outcome, 'holding_missing_images');
    assert.equal(buildImageReplyText('en', d.withImages, d.missingImages),
      IMAGE_REPLY_TEMPLATES.en.unresolvedHolding);
  });

  it('mixed availability: intro for the imaged product + named notice for the missing one', () => {
    const d = decideImageRequestOutcome([imaged, missing]);
    assert.equal(d.outcome, 'send_images');
    const text = buildImageReplyText('sq', d.withImages, d.missingImages, 2);
    assert.ok(text.startsWith(IMAGE_REPLY_TEMPLATES.sq.singlePhotoIntro('Nitro Tech Ripped')));
    assert.ok(text.includes('Carbo one 1kg Limon'));
  });

  it('caps the missing-name enumeration: >cap collapses to the generic line (Bug #1 pin)', () => {
    const missingMany = ['A', 'B', 'C'].map((n) => product(`Product ${n}`));
    const text = buildImageReplyText('sq', [imaged], missingMany, 2);
    assert.ok(text.includes(IMAGE_REPLY_TEMPLATES.sq.missingPhotosGeneric));
    for (const p of missingMany) {
      assert.ok(!text.includes(p.name), `notice must not enumerate ${p.name}`);
    }
  });

  it('multi-image intro when several photos attach', () => {
    const text = buildImageReplyText('en', [imaged, imaged2], []);
    assert.equal(text, IMAGE_REPLY_TEMPLATES.en.multiPhotoIntro);
  });
});

describe('cannedReplyText recognises the photo-reply copy', () => {
  it('classifies every builder output as canned holding copy (P2-3 transcript relabeling)', () => {
    const imaged = product('Nitro Tech Ripped', 1);
    const missing = product('Carbo one 1kg Limon');
    const samples = [
      buildImageReplyText('sq', [imaged], []),
      buildImageReplyText('en', [imaged], []),
      buildImageReplyText('sq', [imaged], [missing]),
      buildImageReplyText('sq', [imaged], [missing, missing, missing], 2),
      buildImageReplyText('sq', [], []),
      buildImageReplyText('en', [], []),
      buildImageReplyText('sq', [imaged, product('X Y', 1)], []),
    ];
    for (const s of samples) {
      assert.equal(isCannedHoldingCopy(s), true, `not recognised: ${JSON.stringify(s)}`);
    }
  });

  it('does not swallow genuine sales replies', () => {
    for (const s of [
      'Nitro Tech Ripped kushton €50.00.',
      'Po, kemi në dispozicion Nitro Tech Ripped dhe Carbo One.',
      'Here is what I found about our products.',
    ]) {
      assert.equal(isCannedHoldingCopy(s), false, s);
    }
  });
});
