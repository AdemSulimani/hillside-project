/**
 * P3-3 (RC-23) — `npm run migrate:verify`: the migration-ledger GATE.
 *
 * Mirrors the checkConfig.ts house convention (a standalone CLI, `--strict`
 * escalates, `--json` machine-readable) and the migrate.ts warn-vs-fail split:
 * a plain run warns, `--strict` (CI / pre-deploy) exits 1 on any violation.
 *
 * Asserts, against the LIVE `_migrations` ledger:
 *   - applied order is monotonic across the on-disk migration set (orphan-tolerant),
 *   - no two distinct on-disk files with the same ordinal were both applied
 *     (except the historical 062 pair — allowlisted),
 *   - no applied file has drifted from its recorded checksum,
 *   - every on-disk applied row carries provenance (checksum + applied_seq),
 *     i.e. the end-of-run reconcile actually ran.
 *
 * Usage:
 *   npm run migrate:verify              # warn-only; exit 0 unless it cannot read the ledger
 *   npm run migrate:verify -- --strict  # exit 1 on any violation (CI)
 *   npm run migrate:verify -- --json    # machine-readable
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from './pool';
import { findDuplicateOrdinals } from './migrationChecks';
import {
  type AppliedRow,
  type LedgerRow,
  assertMonotonicApplied,
  findChecksumDrift,
} from './migrationProvenance';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const json = argv.includes('--json');

  const dir = path.join(__dirname, 'migrations');
  const existsOnDisk = (name: string) => fs.existsSync(path.join(dir, name));
  const readSqlOrNull = (name: string) =>
    existsOnDisk(name) ? fs.readFileSync(path.join(dir, name), 'utf-8') : null;

  const { rows: colRows } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = '_migrations' AND column_name = ANY($1::text[])`,
    [['checksum', 'applied_seq']],
  );
  const hasProv = colRows.length === 2;

  const { rows } = await pool.query<{
    name: string;
    checksum: string | null;
    applied_seq: string | null;
  }>(
    hasProv
      ? 'SELECT name, checksum, applied_seq FROM _migrations'
      : 'SELECT name, NULL::text AS checksum, NULL::bigint AS applied_seq FROM _migrations',
  );

  const ledger: LedgerRow[] = rows.map((r) => ({
    name: r.name,
    applied_seq: r.applied_seq === null ? null : Number(r.applied_seq),
    onDisk: existsOnDisk(r.name),
  }));
  const appliedRows: AppliedRow[] = rows.map((r) => ({ name: r.name, checksum: r.checksum }));
  const onDiskApplied = ledger.filter((r) => r.onDisk).map((r) => r.name);

  const violations = [
    ...assertMonotonicApplied(ledger),
    ...findDuplicateOrdinals(onDiskApplied),
    ...findChecksumDrift(appliedRows, readSqlOrNull),
  ];

  if (hasProv) {
    const missing = ledger.filter((r) => r.onDisk && r.applied_seq === null).map((r) => r.name);
    if (missing.length > 0) {
      violations.push(
        `provenance incomplete: ${missing.length} on-disk applied migration(s) have no applied_seq ` +
          `(${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''}) — the end-of-run ` +
          `reconcile did not run; re-run 'npm run migrate'`,
      );
    }
  } else {
    console.warn(
      '[migrate:verify] provenance columns absent (pre-083 DB) — checked ordering/duplicates only',
    );
  }

  await pool.end().catch(() => undefined);

  if (json) {
    console.log(JSON.stringify({ mode: strict ? 'strict' : 'warn', hasProv, violations }, null, 2));
  } else if (violations.length === 0) {
    console.log(
      `[migrate:verify] OK — ${ledger.length} ledger rows, ${onDiskApplied.length} on-disk; ` +
        `monotonic order, no duplicate-ordinal application, no checksum drift`,
    );
  } else {
    const head = strict ? 'FAILED' : 'WARNING (non-strict)';
    console.error(`[migrate:verify] ${head} — ${violations.length} violation(s):`);
    for (const v of violations) console.error(`  - ${v}`);
  }

  process.exit(strict && violations.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[migrate:verify] unexpected error:', err);
  process.exit(1);
});
