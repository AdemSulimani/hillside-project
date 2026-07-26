/**
 * P3-1 — the pure half of the attribute evidence index.
 *
 * `buildAttributeIndexFromRows` and `findCatalogRowsMatchingRef` decide two things the whole
 * false-positive story rests on: which rows count as having said anything at all (`populated`),
 * and whether a declared `product_ref` identifies exactly one product. Both are pure, so they are
 * tested directly rather than through the gate.
 *
 * No DB, Redis, network or clock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAttributeIndexFromRows,
  catalogGuardAttributesKey,
  findCatalogRowsMatchingRef,
  resolveProductRef,
} from '../catalogAttributeReferenceService';
import type { CatalogAttributeSourceRow, SimilarProductName } from '../../db/models/product';

const TENANT = '00000000-0000-0000-0000-000000000001';

const row = (
  id: string,
  name: string,
  description: string | null = null,
  usage_description: string | null = null,
  category: string | null = 'Proteina',
  structured: Partial<Pick<CatalogAttributeSourceRow, 'brand' | 'flavor' | 'size' | 'color' | 'variant' | 'weight'>> = {},
): CatalogAttributeSourceRow => ({
  id,
  name,
  category,
  description,
  usage_description,
  brand: null,
  flavor: null,
  size: null,
  color: null,
  variant: null,
  weight: null,
  ...structured,
});

/** Real shapes from the dev catalog: a rich description, and a row with no free text at all. */
const ROWS: CatalogAttributeSourceRow[] = [
  row(
    '1',
    'Mega mass 3kg Vanil',
    'Sheqer i reduktuar: Formula përmban karbohidrate komplekse dhe është më e ulët në sheqer.',
    null,
    'Mass Gainer',
  ),
  row('2', 'Mega mass 7kg Qokolad', 'Sheqer i reduktuar: Formula përmban karbohidrate komplekse.'),
  // 37 of 257 real active rows look like this — no description, no usage_description.
  row('3', 'Endurance(gel per energji) 60gr orange', null, null, 'Pre Workout'),
  row('4', 'Carbo One 1kg Orange', 'Karbohidrate me cilësi të lartë për rimbushjen e glikogjenit.'),
];

describe('buildAttributeIndexFromRows', () => {
  it('folds each row once and preserves clause boundaries', () => {
    const index = buildAttributeIndexFromRows(ROWS, 1000);
    const mega = index.rows.find((r) => r.id === '1');
    assert.ok(mega);
    // Name and category are clauses too — attribute evidence lives in the name on this catalog.
    assert.ok(mega.clauses.some((c) => c.includes('mega mass 3kg vanil')));
    assert.ok(mega.clauses.some((c) => c.includes('sheqer i reduktuar')));
    // Folded: lowercase, diacritics stripped.
    assert.ok(mega.clauses.every((c) => c === c.toLowerCase()));
    assert.ok(!mega.clauses.join(' ').includes('ë'));
  });

  it('populated keys off FREE TEXT only — a name and category alone say nothing', () => {
    const index = buildAttributeIndexFromRows(ROWS, 1000);
    assert.equal(index.rows.find((r) => r.id === '1')?.populated, true);
    assert.equal(
      index.rows.find((r) => r.id === '3')?.populated,
      false,
      'a row with no description must not be treated as an authoritative silence',
    );
  });

  it('usage_description counts as free text', () => {
    const index = buildAttributeIndexFromRows([row('9', 'X', null, 'Merrni 1 dozë në ditë.')], 100);
    assert.equal(index.rows[0].populated, true);
  });

  it('truncated is set exactly when the row cap was reached', () => {
    assert.equal(buildAttributeIndexFromRows(ROWS, 1000).truncated, false);
    assert.equal(buildAttributeIndexFromRows(ROWS, ROWS.length).truncated, true);
    assert.equal(buildAttributeIndexFromRows(ROWS, 2).truncated, true);
  });

  it('descriptions are NOT truncated — truncation manufactures flags', () => {
    // A per-row char cap can cut the SUPPORTING sentence while keeping the CONTRADICTING one,
    // which flips a correct reply into a flagged one. The bound is on rows, never on characters.
    const long = 'a'.repeat(3272);
    const index = buildAttributeIndexFromRows([row('9', 'X', `pa sheqer. ${long}`)], 100);
    assert.ok(index.rows[0].clauses.join(' ').length >= 3272);
  });

  it('is deterministic across repeated builds', () => {
    const a = JSON.stringify(buildAttributeIndexFromRows(ROWS, 1000));
    for (let i = 0; i < 5; i += 1) {
      assert.equal(JSON.stringify(buildAttributeIndexFromRows(ROWS, 1000)), a);
    }
  });

  // P1-B: backfilled structured columns are membership evidence.
  it('structured attribute values become their own folded clauses', () => {
    const index = buildAttributeIndexFromRows(
      [row('9', 'BSN Creatine 216gr', null, null, 'Kreatina', { flavor: 'Qershi', weight: '216gr', brand: 'BSN' })],
      100,
    );
    const clauses = index.rows[0].clauses;
    assert.ok(clauses.includes('qershi'));
    assert.ok(clauses.includes('216gr'));
    assert.ok(clauses.includes('bsn'));
  });

  it('structured values do NOT make a free-text-less row `populated` (exclusion-lane contract)', () => {
    const index = buildAttributeIndexFromRows(
      [row('9', 'BSN Creatine 216gr', null, null, 'Kreatina', { flavor: 'Qershi' })],
      100,
    );
    assert.equal(index.rows[0].populated, false);
  });
});

describe('findCatalogRowsMatchingRef', () => {
  const index = buildAttributeIndexFromRows(ROWS, 1000);

  it('exact normalized match', () => {
    const hits = findCatalogRowsMatchingRef('Mega mass 3kg Vanil', index);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].id, '1');
  });

  it('matches through diacritics and case', () => {
    assert.equal(findCatalogRowsMatchingRef('CARBO ONE 1KG ORANGE', index).length, 1);
  });

  it('returns EVERY containment match, so ambiguity is visible rather than silently resolved', () => {
    const hits = findCatalogRowsMatchingRef('Mega mass', index);
    assert.equal(hits.length, 2, 'a boolean matcher could not express this, which is why we return rows');
  });

  it('an unknown ref matches nothing', () => {
    assert.deepEqual(findCatalogRowsMatchingRef('Ghost Whey Protein 2kg', index), []);
  });

  it('an empty ref matches nothing', () => {
    assert.deepEqual(findCatalogRowsMatchingRef('   ', index), []);
  });
});

describe('resolveProductRef', () => {
  const index = buildAttributeIndexFromRows(ROWS, 1000);
  const miss = async (): Promise<SimilarProductName | null> => null;

  it('a unique containment hit resolves via the name index', async () => {
    const r = await resolveProductRef(TENANT, 'Mega mass 3kg Vanil', index, miss);
    assert.equal(r.via, 'name_index');
    assert.equal(r.row?.id, '1');
  });

  it('two hits decline as AMBIGUOUS — tenant scope, which can never contradict', async () => {
    const r = await resolveProductRef(TENANT, 'Mega mass', index, miss);
    assert.equal(r.via, 'ambiguous');
    assert.equal(r.row, null);
  });

  it('falls through to the trigram layer and maps the hit back to a row', async () => {
    const hit = async (): Promise<SimilarProductName> => ({
      name: 'Carbo One 1kg Orange',
      similarity: 0.72,
    });
    const r = await resolveProductRef(TENANT, 'Karbo On 1kg Orandz', index, hit);
    assert.equal(r.via, 'trigram');
    assert.equal(r.row?.id, '4');
  });

  it('a trigram miss declines rather than guessing', async () => {
    const r = await resolveProductRef(TENANT, 'Ghost Whey Protein 2kg', index, miss);
    assert.equal(r.via, 'unresolved');
    assert.equal(r.row, null);
  });

  it('a lookup THROW declines — a guard must never flag because the guard itself failed', async () => {
    const boom = async (): Promise<SimilarProductName | null> => {
      throw new Error('pg down');
    };
    const r = await resolveProductRef(TENANT, 'Something', index, boom);
    assert.equal(r.via, 'lookup_error');
    assert.equal(r.row, null);
  });
});

describe('cache key', () => {
  it('is tenant-scoped and sits beside the price/name guard keys', () => {
    assert.equal(catalogGuardAttributesKey(TENANT), `guard_catalog_attrs:${TENANT}`);
  });
});
