import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { Pool, PoolClient } from 'pg';
import defaultPool from './pool';
import { runMigrationChecks } from './migrationChecks';
import {
  type AppliedRow,
  backfillAppliedSeqSql,
  findChecksumDrift,
  findMultiStatementNoTransactionFiles,
  findTransactionHostileFiles,
  parseAnnotations,
  planSegments,
  sha256,
} from './migrationProvenance';

// Arbitrary constant identifying "the Hillside migration run" cluster-wide.
// Session-level advisory lock: concurrent runners (deploy pre-up, container
// boots, replicas) serialize instead of racing; the session releases it on
// disconnect even if the process dies. Would not survive a move to PgBouncer
// transaction pooling. Shared with the down CLI so the two writers serialize;
// migrate:verify is read-only and deliberately lock-free (worst case it reports
// "provenance incomplete" when raced by a live migrate — rerun it).
export const MIGRATION_LOCK_KEY = '815051262';

export interface RunMigrationsOptions {
  /** Migrations directory. Default: the runner's own `migrations/`. Injected by tests. */
  dir?: string;
  /** Throw on preflight violations instead of warning. Default: `MIGRATE_STRICT === '1'`. */
  strict?: boolean;
  /** One transaction per file (pre-P3-3 behaviour). Default: `MIGRATE_PER_FILE === '1'`. */
  perFile?: boolean;
  /** `SET LOCAL lock_timeout` per batch txn, ms. Default: `MIGRATE_LOCK_TIMEOUT_MS` or 5000. 0 = off. */
  lockTimeoutMs?: number;
  /** `SET LOCAL statement_timeout` per batch txn, ms. Default: `MIGRATE_STATEMENT_TIMEOUT_MS` or 0 (off). */
  statementTimeoutMs?: number;
  /** Pool to run against. Default: the app pool. Injected by tests to target a throwaway DB. */
  pool?: Pool;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Whether `_migrations` has the P3-3 provenance columns yet (false on a pre-083 DB). */
async function hasProvenanceColumns(client: PoolClient): Promise<boolean> {
  const { rows } = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = '_migrations' AND column_name = ANY($1::text[])`,
    [['checksum', 'applied_seq']],
  );
  return rows.length === 2;
}

/** Apply one migration file's SQL, then record it. Names the file on failure. */
async function applyOne(client: PoolClient, dir: string, file: string): Promise<void> {
  const sql = fs.readFileSync(path.join(dir, file), 'utf-8');
  try {
    await client.query(sql);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    throw new Error(
      `[migrate] failed applying ${file}${e.code ? ` (SQLSTATE ${e.code})` : ''}: ` +
        `${e.message ?? String(err)}`,
    );
  }
  await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
}

/**
 * Fill checksum + applied_seq for rows that lack them. Runs AFTER all segments
 * (so migration 083 has taken effect on a fresh DB) and only when the columns
 * exist. Idempotent: a run with nothing to backfill updates nothing. Orphan rows
 * (file deleted) keep checksum = NULL forever.
 */
async function reconcileProvenance(client: PoolClient, dir: string): Promise<void> {
  await client.query(backfillAppliedSeqSql());

  const { rows } = await client.query<{ name: string }>(
    'SELECT name FROM _migrations WHERE checksum IS NULL',
  );
  for (const { name } of rows) {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) continue; // orphan — leave NULL
    const checksum = sha256(fs.readFileSync(filePath, 'utf-8'));
    await client.query(
      'UPDATE _migrations SET checksum = $1 WHERE name = $2 AND checksum IS NULL',
      [checksum, name],
    );
  }
}

/**
 * The hardened runner (audit P3-3). Applies pending migrations in a single batch
 * transaction (all-or-nothing), split into standalone autocommit segments only at
 * `-- migrate:no-transaction` files. Preflight fails fast (strict) or warns (boot)
 * on duplicate/out-of-order ordinals, unannotated transaction-hostile SQL, and
 * checksum drift. Records checksum + a monotonic applied_seq per row.
 *
 * Does NOT end the pool — the caller owns its lifecycle (the CLI wrapper ends the
 * app pool; tests end their own throwaway pool).
 */
export async function runMigrations(opts: RunMigrationsOptions = {}): Promise<void> {
  const dir = opts.dir ?? path.join(__dirname, 'migrations');
  const strict = opts.strict ?? process.env.MIGRATE_STRICT === '1';
  const perFile = opts.perFile ?? process.env.MIGRATE_PER_FILE === '1';
  const lockTimeoutMs = opts.lockTimeoutMs ?? envInt('MIGRATE_LOCK_TIMEOUT_MS', 5000);
  const statementTimeoutMs = opts.statementTimeoutMs ?? envInt('MIGRATE_STATEMENT_TIMEOUT_MS', 0);
  const pool = opts.pool ?? defaultPool;

  const client = await pool.connect();
  let locked = false;

  try {
    // Take the lock before touching _migrations so even two fresh boots racing
    // the CREATE TABLE serialize.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id      SERIAL PRIMARY KEY,
        name    VARCHAR(255) NOT NULL UNIQUE,
        run_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);

    // Forward scan EXCLUDES down migrations (`*.down.sql`); they are applied only
    // by the migrate:down CLI, never as forward migrations.
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
      .sort();

    const provFirst = await hasProvenanceColumns(client);
    const appliedRows: AppliedRow[] = (
      await client.query<AppliedRow>(
        provFirst
          ? 'SELECT name, checksum FROM _migrations'
          : 'SELECT name, NULL::text AS checksum FROM _migrations',
      )
    ).rows;
    const applied = new Set(appliedRows.map((r) => r.name));
    const pending = files.filter((f) => !applied.has(f));

    const readSql = (file: string) => fs.readFileSync(path.join(dir, file), 'utf-8');
    const readSqlOrNull = (file: string) =>
      fs.existsSync(path.join(dir, file)) ? readSql(file) : null;

    // Preflight — fail fast (strict) or warn (boot). Never applies anything first.
    const violations = [
      ...runMigrationChecks(files, applied), // P0-1: dup-ordinal + non-monotonic-pending
      ...findTransactionHostileFiles(pending, readSql), // P3-3: unannotated self-committing DDL
      ...findMultiStatementNoTransactionFiles(pending, readSql), // P3 audit: NT ⇒ single statement
      ...(provFirst ? findChecksumDrift(appliedRows, readSqlOrNull) : []), // P3-3: edited applied file
    ];
    if (violations.length > 0) {
      if (strict) {
        throw new Error(`[migrate] Preflight checks failed:\n${violations.join('\n')}`);
      }
      for (const violation of violations) {
        console.warn('[migrate] WARNING (non-strict mode):', violation);
      }
    }

    if (pending.length === 0) {
      console.log('[migrate] No pending migrations');
    } else {
      const isNoTxn = (file: string) => parseAnnotations(readSql(file)).noTransaction;
      const segments = planSegments(pending, isNoTxn, perFile);

      for (const seg of segments) {
        if (seg.kind === 'txn') {
          await client.query('BEGIN');
          try {
            // Bound the lock/statement wait so a batch cannot stall the live app
            // (migrations run pre-deploy while the OLD containers still serve).
            if (lockTimeoutMs > 0) {
              await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
            }
            if (statementTimeoutMs > 0) {
              await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
            }
            for (const file of seg.files) {
              await applyOne(client, dir, file);
            }
            await client.query('COMMIT');
            for (const file of seg.files) console.log(`[migrate] Applied ${file}`);
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
        } else {
          // No-transaction barrier: standalone autocommit (CREATE INDEX
          // CONCURRENTLY etc.). Not atomic with anything — must be idempotent.
          await applyOne(client, dir, seg.file);
          console.log(`[migrate] Applied ${seg.file} (no-transaction)`);
        }
      }
    }

    // Re-detect: migration 083 may have just created the columns this run.
    if (await hasProvenanceColumns(client)) {
      await reconcileProvenance(client, dir);
    }

    console.log('[migrate] All migrations complete');
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch {
        // Session teardown releases the lock; never mask the original error.
      }
    }
    client.release();
  }
}

async function main(): Promise<void> {
  try {
    await runMigrations();
  } finally {
    await defaultPool.end().catch(() => undefined);
  }
}

// Only run the CLI when invoked directly (`node dist/db/migrate.js`), not when a
// test imports `runMigrations`.
if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] Migration failed:', err);
    process.exit(1);
  });
}
