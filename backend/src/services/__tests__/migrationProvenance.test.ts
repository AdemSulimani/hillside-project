import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  type AppliedRow,
  type LedgerRow,
  assertMonotonicApplied,
  backfillAppliedSeqSql,
  detectHostileTokens,
  findChecksumDrift,
  findTransactionHostileFiles,
  parseAnnotations,
  planSegments,
  sha256,
  stripSqlNoise,
} from '../../db/migrationProvenance';

// A helper mirroring the runner's `readSql` over an in-memory file map.
const reader = (map: Record<string, string>) => (file: string) => {
  const v = map[file];
  if (v === undefined) throw new Error(`no such file ${file}`);
  return v;
};
const readerOrNull = (map: Record<string, string>) => (file: string) =>
  file in map ? map[file] : null;

describe('sha256', () => {
  it('is stable and differs on content change', () => {
    assert.equal(sha256('abc'), sha256('abc'));
    assert.notEqual(sha256('abc'), sha256('abcd'));
    // known vector
    assert.equal(
      sha256('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('parseAnnotations', () => {
  it('detects the no-transaction annotation regardless of spacing/case', () => {
    assert.equal(parseAnnotations('-- migrate:no-transaction\nCREATE ...').noTransaction, true);
    assert.equal(parseAnnotations('--migrate:no-transaction').noTransaction, true);
    assert.equal(parseAnnotations('  --   migrate:no-transaction  ').noTransaction, true);
    assert.equal(parseAnnotations('SELECT 1;\n-- migrate:no-transaction').noTransaction, true);
  });

  it('defaults to transactional', () => {
    assert.equal(parseAnnotations('CREATE TABLE x (id int);').noTransaction, false);
    // must be a comment line, not a stray string
    assert.equal(parseAnnotations("SELECT 'migrate:no-transaction';").noTransaction, false);
  });
});

describe('stripSqlNoise', () => {
  it('removes line + block comments and string/dollar bodies', () => {
    const sql = `-- a COMMIT in a comment
    /* block VACUUM comment */
    SELECT 'a COMMIT literal';
    UPDATE t SET c = $block$ contains COMMIT and BEGIN $block$ WHERE id = 1;`;
    const out = stripSqlNoise(sql);
    assert.ok(!/COMMIT/.test(out), 'COMMIT should be stripped from comments/strings');
    assert.ok(!/VACUUM/.test(out));
    assert.ok(!/BEGIN/.test(out));
    assert.ok(/SELECT/.test(out) && /UPDATE/.test(out), 'executable keywords survive');
  });

  it('does not treat $1 parameter placeholders as dollar-quotes', () => {
    const out = stripSqlNoise('INSERT INTO t (a) VALUES ($1); DROP DATABASE x;');
    assert.ok(/DROP DATABASE/.test(out), '$1 must not swallow following SQL');
  });
});

describe('detectHostileTokens', () => {
  it('flags self-committing / non-transactional DDL', () => {
    assert.deepEqual(detectHostileTokens('CREATE INDEX CONCURRENTLY i ON t (c);'), [
      'CREATE INDEX CONCURRENTLY',
    ]);
    assert.deepEqual(detectHostileTokens('CREATE UNIQUE INDEX CONCURRENTLY i ON t (c);'), [
      'CREATE INDEX CONCURRENTLY',
    ]);
    assert.deepEqual(detectHostileTokens("ALTER TYPE mood ADD VALUE 'sad';"), [
      'ALTER TYPE … ADD VALUE',
    ]);
    assert.deepEqual(detectHostileTokens('VACUUM ANALYZE t;'), ['VACUUM']);
    assert.deepEqual(detectHostileTokens('COMMIT;'), ['COMMIT']);
    assert.deepEqual(detectHostileTokens('BEGIN; SELECT 1;'), ['BEGIN']);
    assert.deepEqual(detectHostileTokens('ALTER SYSTEM SET work_mem = 1;'), ['ALTER SYSTEM']);
  });

  it('does NOT flag BEGIN ATOMIC (a function body, legal in a txn)', () => {
    assert.deepEqual(
      detectHostileTokens('CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;'),
      [],
    );
  });

  it('does NOT flag a COMMIT inside a $block$ prompt body (migration 063 shape)', () => {
    const sql = `UPDATE prompt_blocks SET default_content = $block$
- Always confirm before you COMMIT the order. VACUUM the details with the customer.
$block$ WHERE key = 'guidelines.x';`;
    assert.deepEqual(detectHostileTokens(sql), []);
  });

  it('passes ordinary DDL', () => {
    assert.deepEqual(detectHostileTokens('ALTER TABLE t ADD COLUMN c text; CREATE INDEX i ON t (c);'), []);
  });
});

describe('findTransactionHostileFiles', () => {
  it('flags an unannotated hostile file and passes an annotated one', () => {
    const map = {
      '084_concurrent.sql': 'CREATE INDEX CONCURRENTLY i ON t (c);',
      '085_annotated.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);',
      '086_plain.sql': 'ALTER TABLE t ADD COLUMN c text;',
    };
    const errors = findTransactionHostileFiles(Object.keys(map), reader(map));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /084_concurrent\.sql/);
    assert.match(errors[0], /CREATE INDEX CONCURRENTLY/);
    assert.match(errors[0], /migrate:no-transaction/);
  });
});

describe('planSegments', () => {
  const noTxn = (set: string[]) => (f: string) => set.includes(f);

  it('groups a pure transactional list into one segment', () => {
    assert.deepEqual(planSegments(['a', 'b', 'c'], noTxn([])), [
      { kind: 'txn', files: ['a', 'b', 'c'] },
    ]);
  });

  it('splits at a no-transaction barrier, preserving order', () => {
    assert.deepEqual(planSegments(['a', 'b', 'c', 'd'], noTxn(['b'])), [
      { kind: 'txn', files: ['a'] },
      { kind: 'notxn', file: 'b' },
      { kind: 'txn', files: ['c', 'd'] },
    ]);
  });

  it('handles a leading and trailing barrier', () => {
    assert.deepEqual(planSegments(['a', 'b'], noTxn(['a', 'b'])), [
      { kind: 'notxn', file: 'a' },
      { kind: 'notxn', file: 'b' },
    ]);
  });

  it('perFile degrades transactional segments to size 1 but not no-txn files', () => {
    assert.deepEqual(planSegments(['a', 'b', 'c'], noTxn(['b']), true), [
      { kind: 'txn', files: ['a'] },
      { kind: 'notxn', file: 'b' },
      { kind: 'txn', files: ['c'] },
    ]);
  });

  it('returns nothing for an empty pending list', () => {
    assert.deepEqual(planSegments([], noTxn([])), []);
  });
});

describe('findChecksumDrift', () => {
  const content = 'CREATE TABLE t (id int);';
  const good = sha256(content);

  it('flags an edited applied file', () => {
    const rows: AppliedRow[] = [{ name: '001_t.sql', checksum: good }];
    const errors = findChecksumDrift(rows, readerOrNull({ '001_t.sql': content + ' -- edited' }));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /001_t\.sql/);
    assert.match(errors[0], /DRIFTED/);
  });

  it('passes when the file is unchanged', () => {
    const rows: AppliedRow[] = [{ name: '001_t.sql', checksum: good }];
    assert.deepEqual(findChecksumDrift(rows, readerOrNull({ '001_t.sql': content })), []);
  });

  it('skips rows with a null checksum (not yet baselined)', () => {
    const rows: AppliedRow[] = [{ name: '001_t.sql', checksum: null }];
    assert.deepEqual(findChecksumDrift(rows, readerOrNull({ '001_t.sql': 'anything' })), []);
  });

  it('skips orphan rows whose file was deleted', () => {
    const rows: AppliedRow[] = [{ name: '063_create_offers.sql', checksum: good }];
    assert.deepEqual(findChecksumDrift(rows, readerOrNull({})), []);
  });
});

describe('assertMonotonicApplied', () => {
  it('passes a strictly increasing on-disk sequence', () => {
    const rows: LedgerRow[] = [
      { name: '001_a.sql', applied_seq: 1, onDisk: true },
      { name: '002_b.sql', applied_seq: 2, onDisk: true },
      { name: '010_c.sql', applied_seq: 3, onDisk: true },
    ];
    assert.deepEqual(assertMonotonicApplied(rows), []);
  });

  it('allows the equal-ordinal 062 pair', () => {
    const rows: LedgerRow[] = [
      { name: '062_message_product_context.sql', applied_seq: 1, onDisk: true },
      { name: '062_compact_edge_case_guidelines.sql', applied_seq: 2, onDisk: true },
      { name: '063_catalog_grounding_guardrails.sql', applied_seq: 3, onDisk: true },
    ];
    assert.deepEqual(assertMonotonicApplied(rows), []);
  });

  it('tolerates the real offers history: orphans out-of-order, on-disk set monotonic', () => {
    // Applied order (applied_seq): the offers branch (063/064/065_offers, now
    // deleted) sits BEFORE the catalog-grounding 063–065 — a genuine out-of-order
    // application (C-150). Because every offers file is an orphan, the surviving
    // on-disk set is monotonic and must pass.
    const rows: LedgerRow[] = [
      { name: '062_message_product_context.sql', applied_seq: 1, onDisk: true },
      { name: '062_compact_edge_case_guidelines.sql', applied_seq: 2, onDisk: true },
      { name: '063_create_offers.sql', applied_seq: 3, onDisk: false },
      { name: '064_add_offer_columns_to_orders.sql', applied_seq: 4, onDisk: false },
      { name: '065_offers_promotions_prompt_block.sql', applied_seq: 5, onDisk: false },
      { name: '063_catalog_grounding_guardrails.sql', applied_seq: 6, onDisk: true },
      { name: '064_reconcile_recommendations_names_only.sql', applied_seq: 7, onDisk: true },
      { name: '065_align_guidelines_with_business_rules.sql', applied_seq: 8, onDisk: true },
    ];
    assert.deepEqual(assertMonotonicApplied(rows), []);
  });

  it('flags an on-disk file applied out of ordinal order', () => {
    const rows: LedgerRow[] = [
      { name: '068_a.sql', applied_seq: 1, onDisk: true },
      { name: '063_backport.sql', applied_seq: 2, onDisk: true },
    ];
    const errors = assertMonotonicApplied(rows);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /063_backport\.sql/);
    assert.match(errors[0], /068_a\.sql/);
  });

  it('ignores rows without applied_seq', () => {
    const rows: LedgerRow[] = [
      { name: '001_a.sql', applied_seq: null, onDisk: true },
      { name: '002_b.sql', applied_seq: 1, onDisk: true },
    ];
    assert.deepEqual(assertMonotonicApplied(rows), []);
  });
});

describe('backfillAppliedSeqSql', () => {
  it('continues from the current max in true apply order', () => {
    const sql = backfillAppliedSeqSql();
    assert.match(sql, /COALESCE\(MAX\(applied_seq\), 0\)/);
    assert.match(sql, /ORDER BY run_at ASC, id ASC/);
    assert.match(sql, /WHERE applied_seq IS NULL/);
    assert.match(sql, /UPDATE _migrations/);
  });
});
