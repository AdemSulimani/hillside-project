/**
 * P3-3 (RC-23): integration coverage for the hardened migration runner. Run with
 * `npm run test:integration` against a reachable Postgres (DATABASE_URL, default
 * the dev DB) whose cluster has pgvector installed.
 *
 * Every case runs against a THROWAWAY database created and dropped here
 * (`hillside_migtest_<pid>`) — the dev schema is never touched. This mirrors the
 * throwaway-tenant discipline of channelIsolation.integration.test.ts, scaled up
 * to a throwaway database because the runner owns the whole schema.
 *
 * Proves: full apply + provenance, BATCH atomicity (a mid-sequence failure leaves
 * a clean recoverable state, not a half-migrated schema), no-transaction barrier
 * semantics, up/down/up round-trip identity, checksum drift detection, orphan-row
 * tolerance, and the advisory lock serializing concurrent runs.
 */
import 'dotenv/config';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Pool } from 'pg';
import { runMigrations } from '../db/migrate';
import { runDown } from '../db/migrateDown';
import { assertMonotonicApplied, sha256, type LedgerRow } from '../db/migrationProvenance';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations');
const TEST_DB = `hillside_migtest_${process.pid}`;

function urlWithDb(db: string): string {
  const base = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/hillside';
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
}

let adminPool: Pool; // maintenance DB — creates/drops the throwaway
const tmpDirs: string[] = [];
let dbCounter = 0;

function fixtureDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migtest-'));
  tmpDirs.push(dir);
  for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
  return dir;
}

/** A fresh throwaway DB + a pool on it; caller ends the pool. */
async function freshDb(): Promise<{ pool: Pool; name: string }> {
  const name = `${TEST_DB}_${dbCounter++}`;
  await adminPool.query(`DROP DATABASE IF EXISTS ${name}`);
  await adminPool.query(`CREATE DATABASE ${name}`);
  return { pool: new Pool({ connectionString: urlWithDb(name) }), name };
}

async function dropDb(pool: Pool, name: string): Promise<void> {
  await pool.end().catch(() => undefined);
  await adminPool
    .query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    )
    .catch(() => undefined);
  await adminPool.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => undefined);
}

async function ledger(pool: Pool): Promise<{ name: string; checksum: string | null; applied_seq: number | null }[]> {
  const { rows } = await pool.query<{ name: string; checksum: string | null; applied_seq: string | null }>(
    'SELECT name, checksum, applied_seq FROM _migrations ORDER BY applied_seq NULLS LAST, id',
  );
  return rows.map((r) => ({
    name: r.name,
    checksum: r.checksum,
    applied_seq: r.applied_seq === null ? null : Number(r.applied_seq),
  }));
}

/** A stable schema fingerprint: columns of every public table. */
async function schemaSnapshot(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ sig: string }>(
    `SELECT table_name || '.' || column_name || ':' || data_type AS sig
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY 1`,
  );
  return rows.map((r) => r.sig).join('\n');
}

before(async () => {
  adminPool = new Pool({ connectionString: urlWithDb('postgres') });
});

after(async () => {
  await adminPool.end().catch(() => undefined);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('runMigrations — full apply + provenance', () => {
  it('applies the whole tree to an empty DB, records provenance, and re-runs cleanly', async () => {
    const { pool, name } = await freshDb();
    try {
      await runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true });

      const rows = await ledger(pool);
      assert.ok(rows.some((r) => r.name === '083_migrations_provenance_columns.sql'), '083 applied');

      // Every on-disk row (all of them, on a fresh DB) carries checksum + applied_seq.
      for (const r of rows) {
        assert.ok(r.checksum, `${r.name} has a checksum`);
        assert.ok(r.applied_seq !== null, `${r.name} has an applied_seq`);
      }
      // Checksum matches the file bytes.
      const first = rows[0];
      assert.equal(
        first.checksum,
        sha256(fs.readFileSync(path.join(MIGRATIONS_DIR, first.name), 'utf-8')),
      );
      // Applied order is monotonic across the on-disk set.
      const led: LedgerRow[] = rows.map((r) => ({ name: r.name, applied_seq: r.applied_seq, onDisk: true }));
      assert.deepEqual(assertMonotonicApplied(led), []);

      // Idempotent re-run: no drift, no error, nothing re-applied.
      await runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true });
      const rows2 = await ledger(pool);
      assert.equal(rows2.length, rows.length, 'no rows added on re-run');
    } finally {
      await dropDb(pool, name);
    }
  });
});

describe('runMigrations — batch atomicity (mid-sequence failure recovery)', () => {
  it('rolls the WHOLE batch back on a mid-sequence failure — no half-migrated schema', async () => {
    const { pool, name } = await freshDb();
    const dir = fixtureDir({
      '001_a.sql': 'CREATE TABLE mig_a (id int);',
      '002_b.sql': 'CREATE TABLE mig_b (id int);',
      '003_bad.sql': 'CREATE TABLE mig_c (id int);\nTHIS IS NOT SQL;',
    });
    try {
      await assert.rejects(
        () => runMigrations({ pool, dir, strict: true }),
        /003_bad\.sql/,
        'names the failing file',
      );
      // Batch mode: NONE of the three committed.
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema='public' AND table_name IN ('mig_a','mig_b','mig_c')`,
      );
      assert.equal(tables.rows.length, 0, 'no partial schema left behind');
      const applied = await pool.query('SELECT name FROM _migrations');
      assert.equal(applied.rows.length, 0, 'no migration rows recorded');

      // Fix-forward: correct the bad file, re-run → converges.
      fs.writeFileSync(path.join(dir, '003_bad.sql'), 'CREATE TABLE mig_c (id int);');
      await runMigrations({ pool, dir, strict: true });
      const after2 = await pool.query('SELECT name FROM _migrations ORDER BY name');
      assert.deepEqual(after2.rows.map((r) => r.name), ['001_a.sql', '002_b.sql', '003_bad.sql']);
    } finally {
      await dropDb(pool, name);
    }
  });

  it('a no-transaction barrier splits atomicity: prior segments commit, the failing segment rolls back', async () => {
    const { pool, name } = await freshDb();
    const dir = fixtureDir({
      '001_a.sql': 'CREATE TABLE mig_a (id int);',
      '002_bar.sql': '-- migrate:no-transaction\nCREATE TABLE mig_bar (id int);',
      '003_c.sql': 'CREATE TABLE mig_c (id int);',
      '004_bad.sql': 'BROKEN SQL;',
    });
    try {
      await assert.rejects(() => runMigrations({ pool, dir, strict: true }), /004_bad\.sql/);
      // Segments: [txn 001] [notxn 002] [txn 003,004]. The barrier flushes 001 as
      // its own committed segment, so a failure in the LAST segment rolls back only
      // 003/004 — the documented consequence of a no-transaction barrier.
      const present = async (t: string) =>
        (
          await pool.query(
            `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`,
            [t],
          )
        ).rows.length === 1;
      assert.equal(await present('mig_a'), true, 'segment before the barrier committed');
      assert.equal(await present('mig_bar'), true, 'no-transaction barrier committed');
      assert.equal(await present('mig_c'), false, 'failing segment rolled back');
      const applied = await pool.query('SELECT name FROM _migrations ORDER BY name');
      assert.deepEqual(applied.rows.map((r) => r.name), ['001_a.sql', '002_bar.sql']);
    } finally {
      await dropDb(pool, name);
    }
  });
});

describe('runMigrations — checksum drift', () => {
  it('warns non-strict and throws strict when an applied file is edited', async () => {
    const { pool, name } = await freshDb();
    const dir = fixtureDir({
      '083_migrations_provenance_columns.sql': fs.readFileSync(
        path.join(MIGRATIONS_DIR, '083_migrations_provenance_columns.sql'),
        'utf-8',
      ),
      '001_a.sql': 'CREATE TABLE mig_a (id int);',
    });
    try {
      await runMigrations({ pool, dir, strict: true });
      // Edit the already-applied file.
      fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE mig_a (id int); -- tampered');
      // Non-strict re-run tolerates it (warns).
      await runMigrations({ pool, dir, strict: false });
      // Strict re-run fails fast.
      await assert.rejects(() => runMigrations({ pool, dir, strict: true }), /DRIFTED/);
    } finally {
      await dropDb(pool, name);
    }
  });
});

describe('runMigrations — orphan-row tolerance (pre-reconciliation shape)', () => {
  it('applies cleanly when _migrations holds rows for deleted files', async () => {
    const { pool, name } = await freshDb();
    try {
      // Faithful deployed shape: the full tree is applied, and THEN some files are
      // deleted from disk while their _migrations rows remain (the offers branch,
      // EV-037). Apply first, then inject orphan rows for names not on disk.
      await runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true });
      await pool.query(`
        INSERT INTO _migrations (name, run_at) VALUES
          ('063_create_offers.sql', now() - interval '10 days'),
          ('064_add_offer_columns_to_orders.sql', now() - interval '10 days'),
          ('065_offers_promotions_prompt_block.sql', now() - interval '10 days');
      `);

      // Re-run: idempotent, tolerates the orphans, reconcile backfills their seq.
      await runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true });

      const rows = await ledger(pool);
      // Orphans present, checksum NULL, but still carry an applied_seq.
      const orphan = rows.find((r) => r.name === '063_create_offers.sql');
      assert.ok(orphan, 'orphan row retained');
      assert.equal(orphan!.checksum, null, 'orphan keeps NULL checksum');
      assert.ok(orphan!.applied_seq !== null, 'orphan still gets an applied_seq');
      // On-disk set is still monotonic despite the orphans.
      const led: LedgerRow[] = rows.map((r) => ({
        name: r.name,
        applied_seq: r.applied_seq,
        onDisk: fs.existsSync(path.join(MIGRATIONS_DIR, r.name)),
      }));
      assert.deepEqual(assertMonotonicApplied(led), []);
    } finally {
      await dropDb(pool, name);
    }
  });
});

describe('runMigrations + runDown — up/down/up round-trip', () => {
  it('reverting the reversible tip and re-applying yields an identical schema', async () => {
    const { pool, name } = await freshDb();
    try {
      await runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true });
      const before = await schemaSnapshot(pool);

      // Revert the top two (083 provenance columns + 082 ai_prompt_blobs), both reversible.
      const reverted = await runDown({ pool, dir: MIGRATIONS_DIR, steps: 2 });
      assert.equal(reverted, 2);
      // The provenance columns and the table are gone.
      const gone = await pool.query(`
        SELECT
          (SELECT count(*) FROM information_schema.columns
            WHERE table_name='_migrations' AND column_name='applied_seq') AS seq_cols,
          (SELECT count(*) FROM information_schema.tables
            WHERE table_schema='public' AND table_name='ai_prompt_blobs') AS blob_tbl
      `);
      assert.equal(Number(gone.rows[0].seq_cols), 0);
      assert.equal(Number(gone.rows[0].blob_tbl), 0);

      // Re-apply → schema identical to before the round-trip.
      await runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true });
      const after2 = await schemaSnapshot(pool);
      assert.equal(after2, before, 'schema identical after up/down/up');
    } finally {
      await dropDb(pool, name);
    }
  });

  it('refuses to revert a migration with no paired down file', async () => {
    const { pool, name } = await freshDb();
    const dir = fixtureDir({ '001_a.sql': 'CREATE TABLE mig_a (id int);' });
    try {
      await runMigrations({ pool, dir, strict: false });
      await assert.rejects(() => runDown({ pool, dir, steps: 1 }), /no paired down file/);
    } finally {
      await dropDb(pool, name);
    }
  });
});

describe('runMigrations — advisory lock serializes concurrent runs', () => {
  it('two concurrent runs on the same DB do not double-apply', async () => {
    const { pool, name } = await freshDb();
    try {
      await Promise.all([
        runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true }),
        runMigrations({ pool, dir: MIGRATIONS_DIR, strict: true }),
      ]);
      // Exactly one row per name (UNIQUE would have thrown on a double-apply race).
      const dupes = await pool.query(
        'SELECT name, count(*) FROM _migrations GROUP BY name HAVING count(*) > 1',
      );
      assert.equal(dupes.rows.length, 0, 'no migration applied twice');
    } finally {
      await dropDb(pool, name);
    }
  });
});
