/**
 * Tests for the full-catalog hallucination-guard reference sets (P0-2, RC-02).
 *
 * Key invariants:
 *  - buildPriceSetFromCatalogRows coerces pg NUMERIC strings ("18.00") to numbers —
 *    the legacy buildCatalogPriceSet(matchedProducts) receives those strings raw and
 *    produces an EMPTY set (Number.isFinite rejects strings), which left the price
 *    guard inert at runtime. The full-catalog path must not repeat that bug.
 *  - PROPERTY: a price/name present in the tenant's active catalog never flags,
 *    regardless of what this turn's retrieval window contained (including empty).
 *  - Genuinely fabricated prices/names still flag (the guard keeps its teeth).
 *  - EV-011/013/015 (the three dev "hallucination" false positives) replay green:
 *    the flagged prices/names all match active catalog rows and must not escalate
 *    under full-catalog validation.
 *  - Deterministic name verification can only RESCUE a suspect, never add flags,
 *    and fails open when the similarity lookup errors.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPriceSetFromCatalogRows,
  extractConfigGroundTruthPrices,
  nameMatchesCatalogIndex,
  verifySuspectedNamesAgainstCatalog,
} from '../catalogGuardReferenceService';
import {
  buildCatalogPriceSet,
  filterHallucinatedPrices,
} from '../priceConsistencyGuard';
import type { SimilarProductName } from '../../db/models/product';

const TENANT = '00000000-0000-0000-0000-000000000001';

/** Similarity lookup stub that records calls and always misses. */
function missLookup(calls: string[] = []) {
  return async (_tenantId: string, candidate: string, _min: number): Promise<SimilarProductName | null> => {
    calls.push(candidate);
    return null;
  };
}

// ---------------------------------------------------------------------------
// buildPriceSetFromCatalogRows — pg NUMERIC string coercion
// ---------------------------------------------------------------------------

describe('buildPriceSetFromCatalogRows', () => {
  it('coerces pg NUMERIC strings to numbers (base + discounted)', () => {
    const set = buildPriceSetFromCatalogRows([
      { price: '18.00', discounted_price: null },
      { price: '55.00', discounted_price: '49.90' },
    ]);
    assert.deepEqual([...set.prices].sort((a, b) => a - b), [18, 49.9, 55]);
  });

  it('accepts already-numeric values', () => {
    const set = buildPriceSetFromCatalogRows([{ price: 25, discounted_price: 20 }]);
    assert.ok(set.prices.includes(25));
    assert.ok(set.prices.includes(20));
  });

  it('drops null, empty, and non-numeric values instead of throwing', () => {
    const set = buildPriceSetFromCatalogRows([
      { price: null, discounted_price: undefined },
      { price: '', discounted_price: 'abc' },
      { price: '12.50', discounted_price: null },
    ]);
    assert.deepEqual(set.prices, [12.5]);
  });

  it('documents the legacy inertness: buildCatalogPriceSet over pg-string rows is empty', () => {
    // This is why the matchedProducts-scoped price guard never fired at runtime:
    // NUMERIC columns arrive as strings and Number.isFinite rejects them.
    const legacy = buildCatalogPriceSet([
      { price: '18.00' as unknown as number, discounted_price: null },
    ]);
    assert.equal(legacy.prices.length, 0);
  });
});

// ---------------------------------------------------------------------------
// extractConfigGroundTruthPrices — tenant AI-config text is ground truth
// ---------------------------------------------------------------------------

describe('extractConfigGroundTruthPrices', () => {
  it('extracts prices from qa_pairs (e.g. delivery fee answers)', () => {
    const prices = extractConfigGroundTruthPrices(
      {
        personality_description: null,
        restrictions: [],
        platform_restrictions: [],
        sales_strategy: null,
        objection_handling: null,
        qa_pairs: [
          { question: 'Sa kushton transporti?', answer: 'Transporti kushton €2 në gjithë Kosovën.' },
        ],
      },
      [],
    );
    assert.ok(prices.includes(2));
  });

  it('extracts prices from enabled prompt-block content and restriction lines', () => {
    const prices = extractConfigGroundTruthPrices(
      {
        personality_description: null,
        restrictions: ['Free shipping for orders over €50.'],
        platform_restrictions: [],
        sales_strategy: null,
        objection_handling: null,
        qa_pairs: [],
      },
      ['Aktualisht ofrojmë 10% zbritje për porosi mbi 30 €.'],
    );
    assert.ok(prices.includes(50));
    assert.ok(prices.includes(30));
  });

  it('returns empty for a null config and no blocks', () => {
    assert.deepEqual(extractConfigGroundTruthPrices(null, []), []);
  });
});

// ---------------------------------------------------------------------------
// nameMatchesCatalogIndex — deterministic normalized matching
// ---------------------------------------------------------------------------

describe('nameMatchesCatalogIndex', () => {
  const index = [
    'Mega mass 3kg Qokolad',
    'Mass gainer 3kg Qokolad',
    'Carbo One 1kg Orange',
    'C4 Original 30 servime shije Bostani',
  ];

  it('matches case-insensitively', () => {
    assert.ok(nameMatchesCatalogIndex('MEGA MASS 3KG QOKOLAD', index));
  });

  it('matches a partial reply mention contained in a catalog title', () => {
    assert.ok(nameMatchesCatalogIndex('Carbo One', index));
  });

  it('matches when the catalog name is contained in a longer reply mention', () => {
    assert.ok(nameMatchesCatalogIndex('Carbo One 1kg Orange (i ri)', index));
  });

  it('matches diacritic variants after normalization', () => {
    assert.ok(nameMatchesCatalogIndex('C4 Original 30 servime shije Bostani', ['C4 Original 30 servime shije Bostäni']));
  });

  it('does not match an unrelated fabricated name', () => {
    assert.equal(nameMatchesCatalogIndex('SuperWhey Pro X', index), false);
  });

  it('does not let very short noise strings match via containment', () => {
    assert.equal(nameMatchesCatalogIndex('one', ['Carbo One 1kg Orange']), false);
    assert.equal(nameMatchesCatalogIndex('po', index), false);
  });

  it('returns false for empty input or empty index', () => {
    assert.equal(nameMatchesCatalogIndex('', index), false);
    assert.equal(nameMatchesCatalogIndex('Carbo One', []), false);
  });
});

// ---------------------------------------------------------------------------
// verifySuspectedNamesAgainstCatalog — rescue layer semantics
// ---------------------------------------------------------------------------

describe('verifySuspectedNamesAgainstCatalog', () => {
  const index = ['Mega mass 3kg Qokolad', 'Mass gainer 3kg Qokolad', 'Carbo One 1kg Orange'];

  it('rescues suspects present in the name index without calling the similarity lookup', async () => {
    const calls: string[] = [];
    const result = await verifySuspectedNamesAgainstCatalog(
      TENANT,
      ['Mega Mass 3kg Qokolad'],
      index,
      missLookup(calls),
    );
    assert.deepEqual(result.confirmed, []);
    assert.equal(result.rescued.length, 1);
    assert.equal(result.rescued[0].via, 'name_index');
    assert.deepEqual(calls, []);
  });

  it('rescues typo-level variants via the trigram lookup', async () => {
    const result = await verifySuspectedNamesAgainstCatalog(
      TENANT,
      ['Karbo Uan 1kg'],
      index,
      async () => ({ name: 'Carbo One 1kg Orange', similarity: 0.62 }),
    );
    assert.deepEqual(result.confirmed, []);
    assert.equal(result.rescued[0].via, 'trigram');
    assert.equal(result.rescued[0].matchedCatalogName, 'Carbo One 1kg Orange');
  });

  it('confirms a fabricated name when neither layer matches (guard keeps its teeth)', async () => {
    const result = await verifySuspectedNamesAgainstCatalog(
      TENANT,
      ['SuperWhey Pro X 5000'],
      index,
      missLookup(),
    );
    assert.deepEqual(result.confirmed, ['SuperWhey Pro X 5000']);
    assert.deepEqual(result.rescued, []);
  });

  it('fails open (rescues) when the similarity lookup throws', async () => {
    const result = await verifySuspectedNamesAgainstCatalog(
      TENANT,
      ['SuperWhey Pro X 5000'],
      index,
      async () => {
        throw new Error('db down');
      },
    );
    assert.deepEqual(result.confirmed, []);
    assert.equal(result.rescued[0].via, 'lookup_error');
  });

  it('splits mixed suspects into confirmed and rescued', async () => {
    const result = await verifySuspectedNamesAgainstCatalog(
      TENANT,
      ['Mass gainer 3kg Qokolad', 'Invented Product 9000'],
      index,
      missLookup(),
    );
    assert.deepEqual(result.confirmed, ['Invented Product 9000']);
    assert.equal(result.rescued.length, 1);
  });
});

// ---------------------------------------------------------------------------
// EV-011 / EV-013 / EV-015 replay fixtures (permanent RC-02 regression corpus)
// ---------------------------------------------------------------------------

describe('EV corpus replay — the three dev hallucination alerts stay green', () => {
  // Active catalog rows verified in EV-013 (prices as pg returns them: strings).
  const evCatalogRows = [
    { price: '95.00', discounted_price: null }, // Mega mass 7kg Qokolad
    { price: '55.00', discounted_price: null }, // Mega mass 3kg Vanil
    { price: '52.00', discounted_price: null }, // Mass gainer 3kg Qokolad
    { price: '55.00', discounted_price: null }, // Mega mass 3kg Qokolad
    { price: '18.00', discounted_price: null }, // Carbo One 1kg Orange
  ];
  const evNameIndex = [
    'Mega mass 7kg Qokolad',
    'Mega mass 3kg Vanil',
    'Mass gainer 3kg Qokolad',
    'Mega mass 3kg Qokolad',
    'Carbo One 1kg Orange',
    // The unrelated top-10 retrieval window from EV-011 also stays active:
    'Melatonine 180tab',
    'Pure Creatine 100 capsul',
    'Amino Energy 30 Servime',
  ];

  it('EV-011 e37cd2ce / EV-015 conv 3ea2ace9: €18.00 with an EMPTY retrieval window does not flag', () => {
    // June runtime: matchedProducts=[] (product_ids=[] on the sent message) and the
    // guard stripped a correct price for an active product (Carbo One 1kg Orange).
    const fullCatalogSet = buildPriceSetFromCatalogRows(evCatalogRows);
    const reply = 'Shijet: Limon, Portokall Çmimi: €18.00 për secilën.';
    assert.deepEqual(filterHallucinatedPrices(reply, fullCatalogSet), []);
  });

  it('EV-011 6e13dbe6 / EV-015 conv cf2bf59a: per-flavor €18.00 listing does not flag', () => {
    const fullCatalogSet = buildPriceSetFromCatalogRows(evCatalogRows);
    const reply = 'Limon: €18.00 Portokall: €18.00';
    assert.deepEqual(filterHallucinatedPrices(reply, fullCatalogSet), []);
  });

  it('EV-011 ef3393c1 / conv fcd0af7e: real mass-gainer names outside the retrieval window are rescued deterministically', async () => {
    // The name guard's LLM saw only the unrelated top-10 (Melatonine, Creatine, …) and
    // suspected the two real products the AI had recommended. Full-catalog verification
    // must rescue both via the name index — without needing the trigram lookup.
    const calls: string[] = [];
    const result = await verifySuspectedNamesAgainstCatalog(
      TENANT,
      ['Mega Mass 3kg Qokolad', 'Mass gainer 3kg Qokolad'],
      evNameIndex,
      missLookup(calls),
    );
    assert.deepEqual(result.confirmed, []);
    assert.equal(result.rescued.length, 2);
    assert.ok(result.rescued.every((r) => r.via === 'name_index'));
    assert.deepEqual(calls, []);
  });

  it('negative: a genuinely fabricated price still flags against the full catalog', () => {
    const fullCatalogSet = buildPriceSetFromCatalogRows(evCatalogRows);
    const flagged = filterHallucinatedPrices('Çmimi është €23.50.', fullCatalogSet);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].value, 23.5);
  });
});

// ---------------------------------------------------------------------------
// Multi-currency pin — the full-catalog set is currency-BLIND by design
// ---------------------------------------------------------------------------

describe('multi-currency (LEK/ALL) — pinned behaviour of the currency-blind set', () => {
  // Catalogs are EUR-denominated and the AI is prompted with EUR catalog facts, so
  // replies quote EUR. The guard matches NUMERIC values only (no cross-currency
  // conversion — documented in filterHallucinatedPrices). These tests pin both sides
  // of that contract so a future currency feature can't silently change it.
  const fullCatalogSet = buildPriceSetFromCatalogRows([
    { price: '18.00', discounted_price: null },
    { price: '1800.00', discounted_price: null }, // a genuinely 1800-valued catalog row
  ]);

  it('a LEK-stated price is matched by numeric value, not currency', () => {
    // 1800 LEK passes ONLY because some catalog value equals 1800 — the guard does not
    // know 1800 LEK ≈ €18.
    assert.deepEqual(filterHallucinatedPrices('Çmimi është 1800 LEK.', fullCatalogSet), []);
  });

  it('a converted-currency restatement of a EUR price flags (no cross-currency tolerance)', () => {
    // €18.00 exists, but "1750 LEK" (a plausible conversion) matches no numeric catalog
    // value → flags. This is the known false-positive class if a tenant's AI ever quotes
    // LEK conversions; catalogs/replies must stay EUR-denominated until the guard learns
    // currency conversion.
    const flagged = filterHallucinatedPrices('Çmimi është 1750 LEK.', fullCatalogSet);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].value, 1750);
  });

  it('ALL prefix notation is extracted and matched the same way', () => {
    assert.deepEqual(filterHallucinatedPrices('Kushton ALL 1800.', fullCatalogSet), []);
  });
});

// ---------------------------------------------------------------------------
// PROPERTY: catalog facts never flag, regardless of the retrieval window
// ---------------------------------------------------------------------------

describe('property: full-catalog validation is retrieval-window independent', () => {
  // Deterministic PRNG so failures are reproducible.
  function makePrng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0xffffffff;
    };
  }

  it('any active-catalog price never flags, for any window subset (including empty)', () => {
    const rand = makePrng(20260712);
    for (let run = 0; run < 50; run++) {
      const catalogSize = 1 + Math.floor(rand() * 40);
      const rows = Array.from({ length: catalogSize }, () => {
        const price = (1 + Math.floor(rand() * 20000)) / 100;
        const discounted = rand() < 0.3 ? Math.max(0.01, price - 1) : null;
        // Emulate pg: NUMERIC(10,2) arrives as a fixed-2-decimals string.
        return {
          price: price.toFixed(2),
          discounted_price: discounted === null ? null : discounted.toFixed(2),
        };
      });
      const fullSet = buildPriceSetFromCatalogRows(rows);

      // Pick any catalog price and state it in a reply; the per-turn window is
      // irrelevant to the full-catalog set, so emulate rotation/emptiness by
      // validating ONLY against fullSet exactly as the flag-on guard does.
      const pick = rows[Math.floor(rand() * rows.length)];
      const stated = Number(pick.price).toFixed(2);
      const reply = `Çmimi është €${stated}. Porositni tani!`;
      const flagged = filterHallucinatedPrices(reply, fullSet);
      assert.deepEqual(
        flagged,
        [],
        `run ${run}: catalog price €${stated} flagged despite being in the active catalog`,
      );
    }
  });

  it('any active-catalog name (full or partial mention) is always rescued', async () => {
    const rand = makePrng(42);
    const vocab = ['Whey', 'Protein', 'Creatine', 'Mass', 'Gainer', 'Amino', 'Carbo', 'Beast', 'Iso', 'Zero'];
    for (let run = 0; run < 25; run++) {
      const nameIndex = Array.from({ length: 1 + Math.floor(rand() * 30) }, () => {
        const a = vocab[Math.floor(rand() * vocab.length)];
        const b = vocab[Math.floor(rand() * vocab.length)];
        const kg = 1 + Math.floor(rand() * 5);
        return `${a} ${b} ${kg}kg`;
      });
      const target = nameIndex[Math.floor(rand() * nameIndex.length)];
      // Full mention and a partial (window-independent) mention must both rescue.
      const partial = target.split(' ').slice(0, 2).join(' ');
      const result = await verifySuspectedNamesAgainstCatalog(
        TENANT,
        [target, partial],
        nameIndex,
        missLookup(),
      );
      assert.deepEqual(
        result.confirmed,
        [],
        `run ${run}: catalog name "${target}" (or partial "${partial}") escalated despite being active`,
      );
    }
  });
});
