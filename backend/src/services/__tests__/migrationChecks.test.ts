import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DUPLICATE_ORDINAL_ALLOWLIST,
  findDuplicateOrdinals,
  findNonMonotonicPending,
  maxOrdinal,
  parseOrdinal,
  runMigrationChecks,
} from '../../db/migrationChecks';

const ALLOWLISTED_062_FILES = [
  '062_compact_edge_case_guidelines.sql',
  '062_message_product_context.sql',
];

describe('parseOrdinal', () => {
  it('parses the numeric prefix of a migration filename', () => {
    assert.equal(parseOrdinal('068_add_viber_channel_type.sql'), 68);
    assert.equal(parseOrdinal('007_create_products.sql'), 7);
  });

  it('returns null for names without a numeric prefix', () => {
    assert.equal(parseOrdinal('notes.sql'), null);
    assert.equal(parseOrdinal('_no_number.sql'), null);
    assert.equal(parseOrdinal('62x_bad_separator.sql'), null);
  });
});

describe('maxOrdinal', () => {
  it('returns the highest parseable ordinal', () => {
    assert.equal(
      maxOrdinal(['001_a.sql', '068_b.sql', '007_c.sql']),
      68,
    );
  });

  it('ignores unparseable names and returns null when none parse', () => {
    assert.equal(maxOrdinal(['notes.sql', '010_a.sql']), 10);
    assert.equal(maxOrdinal(['notes.sql']), null);
    assert.equal(maxOrdinal([]), null);
  });

  it('counts rows for files that no longer exist on disk (offers branch)', () => {
    assert.equal(
      maxOrdinal(['065_offers_promotions_prompt_block.sql', '063_create_offers.sql']),
      65,
    );
  });
});

describe('findDuplicateOrdinals', () => {
  it('passes when every ordinal is unique', () => {
    assert.deepEqual(
      findDuplicateOrdinals(['001_a.sql', '002_b.sql', '003_c.sql']),
      [],
    );
  });

  it('allows the historical 062 pair', () => {
    assert.deepEqual(findDuplicateOrdinals(ALLOWLISTED_062_FILES), []);
  });

  it('fails a non-allowlisted duplicate, naming both files', () => {
    const errors = findDuplicateOrdinals([
      '067_remove_product_reply_follow_up.sql',
      '067_dupe.sql',
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /067/);
    assert.match(errors[0], /067_dupe\.sql/);
    assert.match(errors[0], /067_remove_product_reply_follow_up\.sql/);
  });

  it('fails a third 062 file alongside the allowlisted pair', () => {
    const errors = findDuplicateOrdinals([
      ...ALLOWLISTED_062_FILES,
      '062_extra.sql',
    ]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /062_extra\.sql/);
  });

  it('honors a custom allowlist argument', () => {
    const errors = findDuplicateOrdinals(ALLOWLISTED_062_FILES, new Map());
    assert.equal(errors.length, 1);
  });
});

describe('findNonMonotonicPending', () => {
  it('passes on a fresh database (nothing applied)', () => {
    assert.deepEqual(
      findNonMonotonicPending(['001_a.sql', '068_b.sql'], null),
      [],
    );
  });

  it('passes when pending ordinals are at or above the max applied', () => {
    assert.deepEqual(findNonMonotonicPending(['069_x.sql'], 68), []);
    // Equal ordinal is legal: the second allowlisted 062 file pending while
    // 062 is already the max applied must not error.
    assert.deepEqual(
      findNonMonotonicPending(['062_message_product_context.sql'], 62),
      [],
    );
  });

  it('fails a backported file numbered below the max applied ordinal', () => {
    const errors = findNonMonotonicPending(['063_foo.sql'], 68);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /063_foo\.sql/);
    assert.match(errors[0], /68/);
  });
});

describe('runMigrationChecks', () => {
  it('accepts the real-world shape: current tree + historical offers rows applied', () => {
    // Disk: unique ordinals plus the allowlisted 062 pair.
    const disk = [
      '061_concise_messaging_style.sql',
      ...ALLOWLISTED_062_FILES,
      '063_catalog_grounding_guardrails.sql',
      '064_reconcile_recommendations_names_only.sql',
      '065_align_guidelines_with_business_rules.sql',
      '066_increase_recommendation_limit_to_3.sql',
      '067_remove_product_reply_follow_up.sql',
      '068_add_viber_channel_type.sql',
    ];
    // Applied: everything on disk plus offers-branch rows whose files were
    // deleted from the repo (EV-037) — must never trip the checks.
    const applied = new Set([
      ...disk,
      '063_create_offers.sql',
      '064_add_offer_columns_to_orders.sql',
      '065_offers_promotions_prompt_block.sql',
    ]);
    assert.deepEqual(runMigrationChecks(disk, applied), []);
  });

  it('accepts a fresh database applying the full tree', () => {
    const disk = [...ALLOWLISTED_062_FILES, '063_catalog_grounding_guardrails.sql'];
    assert.deepEqual(runMigrationChecks(disk, new Set()), []);
  });

  it('reports both duplicate and out-of-order violations together', () => {
    const disk = ['067_a.sql', '067_b.sql', '063_backport.sql'];
    const applied = new Set(['067_a.sql', '068_c.sql']);
    const errors = runMigrationChecks(disk, applied);
    // One duplicate (067 pair) + two pending files below max applied 68
    // (067_b, 063_backport).
    assert.equal(errors.length, 3);
    assert.equal(errors.filter((e) => e.includes('duplicate')).length, 1);
    assert.equal(errors.filter((e) => e.includes('below the highest')).length, 2);
  });

  it('exposes the allowlist keyed by ordinal with exact filenames', () => {
    const allowed = DUPLICATE_ORDINAL_ALLOWLIST.get(62);
    assert.ok(allowed);
    assert.deepEqual([...allowed].sort(), ALLOWLISTED_062_FILES);
  });
});
