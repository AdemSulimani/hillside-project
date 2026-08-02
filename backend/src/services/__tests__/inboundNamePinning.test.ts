/**
 * Pins `inboundNamePinning.ts` — the deterministic recovery of products the customer
 * explicitly named — against the live false-denial bug (conv ee183c2e, 2026-07-20):
 * "Sa kushton nitro tech ripped?" was routed to stale persisted context, "Nitro Tech
 * Ripped" never entered the injected pool, and rule R6 turned the retrieval miss into a
 * confident "we don't carry it". Pinning makes an explicitly-named product impossible
 * to miss; these tests also pin the invariant that a message naming NO catalog product
 * pins nothing (so genuine "we don't carry X" denials stay untouched).
 *
 * Pure imports + injected lookups only — no database, no OpenAI client.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Product } from '../../db/models/product';
import {
  extractCandidateNameGrams,
  resolveInboundNamedProducts,
  resolveGramsToProducts,
  productsDeniedInReply,
} from '../inboundNamePinning';

let seq = 0;
function product(name: string): Product {
  seq += 1;
  return {
    id: `00000000-0000-4000-9000-${String(seq).padStart(12, '0')}`,
    tenant_id: 'tenant-1',
    name,
    brand: null,
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

const nitroRipped = product('Nitro Tech Ripped');
const nitroKeks = product('Nitro Tech 1.8kg  Keks');
const carboLimon = product('Carbo one 1kg Limon');

describe('extractCandidateNameGrams', () => {
  it('extracts the product phrase from the live-bug message, price cues trimmed', () => {
    const grams = extractCandidateNameGrams('Sa kushton nitro tech ripped?');
    assert.ok(grams.includes('nitro tech ripped'), grams.join(' | '));
    assert.ok(grams.includes('nitro tech'), grams.join(' | '));
    for (const g of grams) {
      assert.ok(!/\b(sa|kushton)\b/.test(g), `price cue leaked into gram: ${g}`);
    }
  });

  it('returns nothing for bare follow-ups and pure question filler', () => {
    assert.deepEqual(extractCandidateNameGrams('Sa kushton?'), []);
    assert.deepEqual(extractCandidateNameGrams('a e keni kete?'), []);
    assert.deepEqual(extractCandidateNameGrams('po ata?'), []);
    assert.deepEqual(extractCandidateNameGrams(''), []);
  });

  it('emits no uni-gram for tokens already covered by multi-grams', () => {
    for (const g of extractCandidateNameGrams('a keni proteina whey gold standard?')) {
      assert.ok(g.includes(' '), `uni-gram emitted: ${g}`);
    }
  });

  it('emits a guarded uni-gram for a lone Albanianized name (the kreatinen gap)', () => {
    assert.deepEqual(extractCandidateNameGrams('A e keni kreatinen?'), ['kreatinen']);
  });

  it('uni-gram guards: short tokens and option-words never qualify', () => {
    assert.deepEqual(extractCandidateNameGrams('a e keni kete?'), []); // "kete" < 5 chars
    assert.deepEqual(extractCandidateNameGrams('a keni tjera?'), []); // option-word stoplisted
  });

  it('emits a uni-gram for a short letter+digit product code (the C4 false-denial trap)', () => {
    // "A keni naj C4" used to extract [] — 'keni'/'naj' stopworded, 'c4' under the ≥5 floor —
    // so pinning never ran and the false-denial backstop stayed disarmed.
    assert.deepEqual(extractCandidateNameGrams('A keni naj C4'), ['c4']);
    // "Pershendejte" (typo, not stopworded) also survives as a uni-gram — 'c4' must still be there.
    assert.ok(extractCandidateNameGrams('Pershendejte a keni c4').includes('c4'));
    // Pure digits stay excluded.
    assert.deepEqual(extractCandidateNameGrams('a keni 30?'), []);
  });

  it('drops grams with an interior stopword but keeps their content tokens via uni-grams', () => {
    const grams = extractCandidateNameGrams('a keni kreatinen edhe nitro tech?');
    assert.ok(!grams.some((g) => /\bedhe\b/.test(g)), `interior stopword leaked: ${grams.join(' | ')}`);
    assert.ok(grams.includes('nitro tech'), grams.join(' | '));
    assert.ok(grams.includes('kreatinen'), grams.join(' | '));
  });

  it('orders longest-first and caps the gram count', () => {
    const grams = extractCandidateNameGrams(
      'me duhet nitro tech ripped edhe carbo one limon edhe cell tech fruit edhe beta alanine ananas',
    );
    assert.ok(grams.length <= 8);
    for (let i = 1; i < grams.length; i++) {
      assert.ok(grams[i - 1].length >= grams[i].length, 'not longest-first');
    }
  });
});

describe('resolveInboundNamedProducts', () => {
  it('pins the exactly-named product (live-bug replay)', async () => {
    const result = await resolveInboundNamedProducts('tenant-1', 'Sa kushton nitro tech ripped?', {
      bySubstring: async (_t, term) =>
        'nitro tech ripped'.includes(term.toLowerCase()) || term.toLowerCase().includes('nitro')
          ? [nitroRipped, nitroKeks]
          : [],
    });
    assert.ok(result.some((p) => p.id === nitroRipped.id), 'exact product not pinned');
    // Exact-name gram ranks the exact row first.
    assert.equal(result[0].id, nitroRipped.id);
  });

  it('pins an inflected name via the stemmed rung', async () => {
    const calls: string[] = [];
    const result = await resolveInboundNamedProducts('tenant-1', 'Sa kushton nitro techin?', {
      bySubstring: async (_t, term) => {
        calls.push(term);
        // Raw "%nitro techin%" misses; the stemmed "%tech%" rung hits.
        return term.toLowerCase() === 'tech' ? [nitroRipped, nitroKeks] : [];
      },
    });
    assert.ok(result.some((p) => p.id === nitroRipped.id), `not pinned; lookups: ${calls.join(', ')}`);
  });

  it('does not pin unrelated rows returned by a broad lookup', async () => {
    const result = await resolveInboundNamedProducts('tenant-1', 'Sa kushton carbo limonin?', {
      // A broad "%limon%"-style return including a non-carbo row: the token filter must
      // keep only the product the message actually references.
      bySubstring: async () => [carboLimon, product('Amino rest 500gr Qershi&Limonad')],
    });
    assert.deepEqual(result.map((p) => p.id), [carboLimon.id]);
  });

  it('pins multiple named products, capped at 3', async () => {
    const a = product('Product Alpha One');
    const b = product('Product Beta Two');
    const c = product('Product Gamma Three');
    const d = product('Product Delta Four');
    const byName = new Map([
      ['product alpha one', a], ['product beta two', b],
      ['product gamma three', c], ['product delta four', d],
    ]);
    const result = await resolveInboundNamedProducts(
      'tenant-1',
      'a i keni product alpha one, product beta two, product gamma three, product delta four?',
      {
        bySubstring: async (_t, term) => {
          const hit = byName.get(term.toLowerCase());
          return hit ? [hit] : [];
        },
        bySimilarity: async () => [],
      },
    );
    assert.ok(result.length <= 3, `cap exceeded: ${result.length}`);
    assert.ok(result.length >= 2, 'expected multiple pins');
  });

  it('makes zero lookups when the message contains no candidate grams', async () => {
    let lookups = 0;
    const result = await resolveInboundNamedProducts('tenant-1', 'Sa kushton?', {
      bySubstring: async () => {
        lookups += 1;
        return [];
      },
    });
    assert.deepEqual(result, []);
    assert.equal(lookups, 0);
  });

  it('respects the lookup budget across ALL rungs (substring + similarity)', async () => {
    let lookups = 0;
    await resolveInboundNamedProducts(
      'tenant-1',
      'krem dielli super mega ultra hiper turbo ekstra fantastik legjendar total',
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
    assert.ok(lookups <= 8, `lookup budget exceeded: ${lookups}`);
  });

  it('genuine-denial invariant: a not-carried name pins nothing', async () => {
    const result = await resolveInboundNamedProducts('tenant-1', 'A keni ostrovit whey gold?', {
      bySubstring: async () => [],
      bySimilarity: async () => [],
    });
    assert.deepEqual(result, []);
  });

  it('a gram must match every token — "whey gold" does not pin a product named just "Whey"', async () => {
    const bareWhey = product('Whey');
    const result = await resolveInboundNamedProducts('tenant-1', 'a keni whey gold?', {
      bySubstring: async () => [bareWhey],
      bySimilarity: async () => [],
    });
    assert.deepEqual(result, []);
  });

  it('dialect-variant rung: "kreatinen" pins the English-spelled Creatine row (the live gap)', async () => {
    const creatine = product('Creatine Monohydrate 300g');
    const terms: string[] = [];
    const result = await resolveInboundNamedProducts('tenant-1', 'A e keni kreatinen?', {
      bySubstring: async (_t, term) => {
        terms.push(term);
        // Raw "%kreatinen%", stemmed "%kreatin%", and variant "%kreatine%" all miss the
        // English-spelled catalog; only the curated cross-spelling "creatine" hits.
        return term.toLowerCase() === 'creatine' ? [creatine] : [];
      },
      bySimilarity: async () => [],
    });
    assert.deepEqual(result.map((p) => p.id), [creatine.id], `terms tried: ${terms.join(', ')}`);
  });

  it('trigram rung: a typo pins via similarity with no token filter', async () => {
    const ripped = product('Nitro Tech Ripped');
    const result = await resolveInboundNamedProducts('tenant-1', 'a keni nitro tek riped?', {
      bySubstring: async () => [],
      bySimilarity: async (_t, _candidate, threshold) => {
        assert.equal(threshold, 0.48);
        return [ripped];
      },
    });
    assert.deepEqual(result.map((p) => p.id), [ripped.id]);
  });

  it('resolveGramsToProducts resolves only the grams it is given', async () => {
    const creatine = product('Creatine Monohydrate 300g');
    const looked: string[] = [];
    const result = await resolveGramsToProducts('tenant-1', ['kreatinen'], {
      bySubstring: async (_t, term) => {
        looked.push(term);
        return term.toLowerCase() === 'creatine' ? [creatine] : [];
      },
      bySimilarity: async () => [],
    });
    assert.deepEqual(result.map((p) => p.id), [creatine.id]);
    assert.ok(looked.every((t) => t.includes('kreatin') || t.includes('creatine')), looked.join(', '));
  });

  it('bySimilarity failure is swallowed like every other lookup failure', async () => {
    const result = await resolveInboundNamedProducts('tenant-1', 'A e keni kreatinen?', {
      bySubstring: async () => [],
      bySimilarity: async () => {
        throw new Error('db down');
      },
    });
    assert.deepEqual(result, []);
  });

  it('never throws — a failing lookup returns []', async () => {
    const result = await resolveInboundNamedProducts('tenant-1', 'Sa kushton nitro tech ripped?', {
      bySubstring: async () => {
        throw new Error('db down');
      },
    });
    assert.deepEqual(result, []);
  });
});

describe('productsDeniedInReply — clause-scoped denial matching', () => {
  it('detects the live false denial (product named inside the denial clause)', () => {
    const denied = productsDeniedInReply(
      [nitroRipped],
      'Më vjen keq, por nuk e kemi në dispozicion produktin Nitro Tech Ripped. ' +
        'Nëse dëshironi, mund tju sugjeroj disa alternativa nga kategoria e pre-workout.',
    );
    assert.deepEqual(denied.map((p) => p.id), [nitroRipped.id]);
  });

  it('does NOT count a pinned product offered as an ALTERNATIVE (separate clause/line)', () => {
    const compactWhey = product('Compact whey gold 2.3kg Vanil');
    const denied = productsDeniedInReply(
      [compactWhey],
      'Ky produkt nuk është në dispozicion. Mund të sugjeroj disa alternativa nga kategoria e proteinave:\n' +
        'Compact gold whey 1kg Dredhz\nCompact whey gold 2.3kg Vanil',
    );
    assert.deepEqual(denied, []);
  });

  it('does NOT count an offer after a contrast conjunction in the SAME sentence', () => {
    const denied = productsDeniedInReply(
      [nitroRipped],
      'Ostrovit whey nuk e kemi, por ju sugjerojmë Nitro Tech Ripped me çmim €50.',
    );
    assert.deepEqual(denied, []);
  });

  it('still fires when the denial itself sits after a conjunction', () => {
    const denied = productsDeniedInReply(
      [nitroRipped],
      'Faleminderit për pyetjen, por Nitro Tech Ripped nuk është në dispozicion.',
    );
    assert.deepEqual(denied.map((p) => p.id), [nitroRipped.id]);
  });

  it('detects English denials and folded apostrophes', () => {
    const denied = productsDeniedInReply(
      [nitroRipped],
      "Sorry, we don't carry Nitro Tech Ripped. However, we have other pre-workouts.",
    );
    assert.deepEqual(denied.map((p) => p.id), [nitroRipped.id]);
  });

  it('returns [] for replies with no denial wording, empty inputs', () => {
    assert.deepEqual(
      productsDeniedInReply([nitroRipped], 'Nitro Tech Ripped kushton €50.00.'),
      [],
    );
    assert.deepEqual(productsDeniedInReply([], 'nuk e kemi'), []);
    assert.deepEqual(productsDeniedInReply([nitroRipped], ''), []);
  });

  it('catches a bare family-code denial ("nuk e kemi C4") via the code-token tier', () => {
    const c4Ripped = product('C4 Ripped pre-workout 30servime Ananas');
    const c4Original = product('C4 Original 30servime shije Mjedre');
    const denied = productsDeniedInReply(
      [c4Ripped, c4Original],
      'Më vjen keq, por nuk e kemi C4 në dispozicion. Mund tju interesojnë produktet tona të tjera.',
    );
    assert.deepEqual(
      denied.map((p) => p.id).sort(),
      [c4Ripped.id, c4Original.id].sort(),
    );
  });
});
