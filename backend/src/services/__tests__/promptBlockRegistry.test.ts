/**
 * P3-5 (RC-26/RC-17): the prompt-block version registry.
 *
 * What these guarantee:
 *   - the hash identifies the STORED TEMPLATE, so one block is one version regardless of the
 *     customer's language (the single mistake that would make every reply report an unknown
 *     version and turn the governance alarm into pure noise);
 *   - registration reaches its bind parameters (the suite has no DB — `upsertParams` is exported
 *     for exactly this, mirroring `aiDecisionLedger.insertParams`);
 *   - the locked-catalog marker is order-independent and content-sensitive, which is what lets the
 *     reply path trust a Redis GET instead of issuing a force-sync UPDATE.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';

import {
  lockedCatalogMarker,
  promptBlockContentHash,
  shortHash,
  upsertParams,
} from '../../db/models/promptBlockVersion';
import {
  assembleGuidelinesFromBlocks,
  buildGuidelinePlaceholderMap,
  expandPromptPlaceholders,
} from '../promptAssemblyService';
import type { TenantPromptBlockRow } from '../../db/models/promptBlock';

function row(over: Partial<TenantPromptBlockRow> = {}): TenantPromptBlockRow {
  return {
    id: 'row-1',
    tenant_id: 'tenant-1',
    prompt_block_id: 'catalog-1',
    block_key: 'guidelines.language',
    enabled: true,
    content: 'Reply in {{LANGUAGE_NAME}}.',
    sort_order: 10,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  } as TenantPromptBlockRow;
}

describe('promptBlockContentHash', () => {
  it('is sha256 hex over the UTF-8 bytes', () => {
    const content = 'Përshëndetje — 10€';
    assert.equal(
      promptBlockContentHash(content),
      createHash('sha256').update(content, 'utf8').digest('hex'),
    );
  });

  it('is stable across calls and distinguishes a one-char edit', () => {
    assert.equal(promptBlockContentHash('abc'), promptBlockContentHash('abc'));
    assert.notEqual(promptBlockContentHash('abc'), promptBlockContentHash('abd'));
  });

  it('shortHash keeps the first 12 chars', () => {
    const full = promptBlockContentHash('abc');
    assert.equal(shortHash(full), full.slice(0, 12));
    assert.equal(shortHash(full).length, 12);
  });

  it('THE RULE: one stored block is ONE version regardless of reply locale', () => {
    // `expandPromptPlaceholders` substitutes locale-dependent values, so hashing the EXPANDED text
    // would give this block two hashes — and neither would match the registry, which stores the
    // template. Every reply would then report an unknown version. This is the whole contract.
    const template = row().content;
    const sq = expandPromptPlaceholders(template, buildGuidelinePlaceholderMap({ language: 'sq' }));
    const en = expandPromptPlaceholders(template, buildGuidelinePlaceholderMap({ language: 'en' }));

    assert.notEqual(sq, en, 'fixture must actually differ by locale, or the test proves nothing');
    assert.notEqual(
      promptBlockContentHash(sq),
      promptBlockContentHash(en),
      'expanded text differs by locale — which is why we do not hash it',
    );
    assert.equal(promptBlockContentHash(template), promptBlockContentHash(template));
  });

  it('the assembly reports the STORED content, not the expanded text', () => {
    // The end-to-end version of the rule above: whatever `onBlock` hands back must hash to the
    // same value in both locales, because that is what aiService stamps into the ledger.
    const rows = [row()];
    const hashes = (['sq', 'en'] as const).map((language) => {
      const seen: string[] = [];
      assembleGuidelinesFromBlocks(rows, { language }, {
        hasImages: false,
        onBlock: ({ content }) => seen.push(promptBlockContentHash(content)),
      });
      return seen;
    });
    assert.deepEqual(hashes[0], hashes[1]);
    assert.equal(hashes[0].length, 1);
  });
});

describe('upsertParams', () => {
  it('binds key, hash, content, length, source and email in order', () => {
    const params = upsertParams(
      { block_key: 'guidelines.language', content: 'hello' },
      'admin_catalog',
      'admin@example.com',
    );
    assert.deepEqual(params, [
      'guidelines.language',
      promptBlockContentHash('hello'),
      'hello',
      5,
      'admin_catalog',
      'admin@example.com',
    ]);
  });

  it('binds a null email rather than undefined', () => {
    // `undefined` reaches pg as a missing bind parameter, not as SQL NULL.
    assert.equal(upsertParams({ block_key: 'k', content: 'c' }, 'reconcile')[5], null);
    assert.equal(upsertParams({ block_key: 'k', content: 'c' }, 'reconcile', null)[5], null);
  });

  it('char_count is the content length, not the hash length', () => {
    const params = upsertParams({ block_key: 'k', content: 'x'.repeat(1478) }, 'backfill');
    assert.equal(params[3], 1478);
  });
});

describe('lockedCatalogMarker', () => {
  const a = { block_key: 'guidelines.language', content: 'A' };
  const b = { block_key: 'guidelines.catalog_integrity', content: 'B' };

  it('is independent of input order', () => {
    // The marker is compared across processes that may read rows in different orders. If ordering
    // leaked in, every instance would think every tenant was stale and force-sync on every reply —
    // the exact herd this mechanism removes.
    assert.equal(lockedCatalogMarker([a, b]), lockedCatalogMarker([b, a]));
  });

  it('changes when any block content changes', () => {
    const before = lockedCatalogMarker([a, b]);
    assert.notEqual(before, lockedCatalogMarker([a, { ...b, content: 'B2' }]));
  });

  it('changes when a block is added or removed', () => {
    assert.notEqual(lockedCatalogMarker([a, b]), lockedCatalogMarker([a]));
    assert.notEqual(lockedCatalogMarker([a]), lockedCatalogMarker([]));
  });

  it('distinguishes the same content under a different key', () => {
    assert.notEqual(
      lockedCatalogMarker([{ block_key: 'k1', content: 'X' }]),
      lockedCatalogMarker([{ block_key: 'k2', content: 'X' }]),
    );
  });

  it('is a fixed-width token', () => {
    assert.equal(lockedCatalogMarker([a, b]).length, 32);
    assert.equal(lockedCatalogMarker([]).length, 32);
  });
});
