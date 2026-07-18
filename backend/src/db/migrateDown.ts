/**
 * P3-3 (RC-23) — `npm run migrate:down`: reverse the reversible subset.
 *
 * Down migrations are deliberately LIMITED. Postgres DDL rollback is exact for
 * additive structural changes (CREATE TABLE / ADD COLUMN / CREATE INDEX) but the
 * inverse of a data/prompt change is "the previous content", which lives in the
 * P3-5 registry, not here. So a migration gets a paired `NNN_name.down.sql` ONLY
 * when its reverse is a clean guarded drop; destructive/data changes stay
 * expand→contract + fix-forward. The runner NEVER auto-generates a down.
 *
 * This tool reverts from the TOP of the applied stack downward (you cannot revert
 * a middle migration without reverting everything applied after it), each in its
 * own transaction, deleting the `_migrations` row atomically with the reverse SQL.
 *
 * Production is gated: prod rollback is "re-deploy the previous tag" (DEPLOYMENT.md),
 * NOT a down migration. The CLI refuses to run unless MIGRATE_ALLOW_DOWN=1.
 *
 * Usage (all require MIGRATE_ALLOW_DOWN=1):
 *   npm run migrate:down                       # revert the single most-recent migration
 *   npm run migrate:down -- --steps=2          # revert the top 2
 *   npm run migrate:down -- --to=081           # revert down to (not including) ordinal 081
 *   npm run migrate:down -- --to=082_ai_prompt_blobs.sql
 *   npm run migrate:down -- --dry-run          # print the plan, change nothing
 *   npm run migrate:down -- --force            # cross a no-transaction boundary anyway
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import defaultPool from './pool';
import { MIGRATION_LOCK_KEY } from './migrate';
import { parseOrdinal } from './migrationChecks';
import { parseAnnotations } from './migrationProvenance';

export interface RunDownOptions {
  pool?: Pool;
  dir?: string;
  steps?: number;
  to?: string | null;
  dryRun?: boolean;
  force?: boolean;
}

interface StackRow {
  name: string;
  downFile: string; // NNN_name.down.sql
  hasDown: boolean;
  onDisk: boolean;
  noTransaction: boolean;
}

function toDownFile(name: string): string {
  return name.replace(/\.sql$/, '.down.sql');
}

function matchesTarget(name: string, target: string): boolean {
  if (name === target) return true;
  const t = parseOrdinal(target.endsWith('.sql') ? target : `${target}_x.sql`);
  const ord = parseOrdinal(name);
  return t !== null && ord !== null && ord === t;
}

/**
 * Revert the reversible subset. Injectable (pool/dir) so the integration test can
 * round-trip against a throwaway DB. NOTE: the MIGRATE_ALLOW_DOWN gate lives in
 * the CLI wrapper, not here — a programmatic caller (test) opts in by calling this.
 */
export async function runDown(opts: RunDownOptions = {}): Promise<number> {
  const pool = opts.pool ?? defaultPool;
  const dir = opts.dir ?? path.join(__dirname, 'migrations');
  const steps = Math.max(1, opts.steps ?? 1);
  const to = opts.to ?? null;
  const dryRun = opts.dryRun ?? false;
  const force = opts.force ?? false;

  const client = await pool.connect();
  let locked = false;

  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    // Order the stack top-first. applied_seq is the authoritative order when
    // present; fall back to run_at for a pre-083 DB.
    const { rows: colRows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = '_migrations' AND column_name = 'applied_seq'`,
    );
    const hasSeq = colRows.length === 1;
    const { rows } = await client.query<{ name: string }>(
      hasSeq
        ? 'SELECT name FROM _migrations ORDER BY applied_seq DESC NULLS LAST, run_at DESC, id DESC'
        : 'SELECT name FROM _migrations ORDER BY run_at DESC, id DESC',
    );

    const stack: StackRow[] = rows.map((r) => {
      const downFile = toDownFile(r.name);
      const onDisk = fs.existsSync(path.join(dir, r.name));
      const downPath = path.join(dir, downFile);
      const hasDown = fs.existsSync(downPath);
      const fwdNoTxn =
        onDisk && parseAnnotations(fs.readFileSync(path.join(dir, r.name), 'utf-8')).noTransaction;
      const downNoTxn = hasDown && parseAnnotations(fs.readFileSync(downPath, 'utf-8')).noTransaction;
      return { name: r.name, downFile, hasDown, onDisk, noTransaction: fwdNoTxn || downNoTxn };
    });

    if (stack.length === 0) {
      console.log('[migrate:down] nothing applied — nothing to revert');
      return 0;
    }

    let toRevert: StackRow[];
    if (to !== null) {
      const idx = stack.findIndex((r) => matchesTarget(r.name, to));
      if (idx === -1) throw new Error(`--to target '${to}' is not an applied migration`);
      toRevert = stack.slice(0, idx); // everything applied AFTER the target
    } else {
      toRevert = stack.slice(0, steps);
    }

    if (toRevert.length === 0) {
      console.log('[migrate:down] already at target — nothing to revert');
      return 0;
    }

    // Safety: every migration in the range needs a paired down file (this also
    // rejects orphan rows whose forward file is gone — they have no down file).
    const missing = toRevert.filter((r) => !r.hasDown);
    if (missing.length > 0) {
      throw new Error(
        `refusing to revert: no paired down file for ${missing.map((r) => r.name).join(', ')}.\n` +
          `Reversibility is opt-in — author ${missing.map((r) => r.downFile).join(', ')}, or use ` +
          `fix-forward. (A down file is only appropriate for a cleanly-reversible structural change.)`,
      );
    }

    // Safety: a no-transaction boundary (e.g. a CONCURRENTLY index) can't be
    // auto-reverted in a transaction — DROP INDEX CONCURRENTLY must be run by hand.
    const noTxn = toRevert.filter((r) => r.noTransaction);
    if (noTxn.length > 0 && !force) {
      throw new Error(
        `refusing to auto-revert across a no-transaction boundary: ${noTxn
          .map((r) => r.name)
          .join(', ')}. Run the reverse by hand (e.g. DROP INDEX CONCURRENTLY IF EXISTS …), ` +
          `or pass --force to run the paired down file anyway.`,
      );
    }

    console.log(
      `[migrate:down] plan (top-first): ${toRevert.map((r) => r.name).join(' -> ')}` +
        (dryRun ? ' [dry-run]' : ''),
    );
    if (dryRun) return 0;

    for (const row of toRevert) {
      const downSql = fs.readFileSync(path.join(dir, row.downFile), 'utf-8');
      await client.query('BEGIN');
      try {
        await client.query(downSql);
        await client.query('DELETE FROM _migrations WHERE name = $1', [row.name]);
        await client.query('COMMIT');
        console.log(`[migrate:down] reverted ${row.name}`);
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        const e = err as { code?: string; message?: string };
        throw new Error(
          `[migrate:down] failed reverting ${row.name}${e.code ? ` (SQLSTATE ${e.code})` : ''}: ` +
            `${e.message ?? String(err)}`,
        );
      }
    }

    console.log(`[migrate:down] reverted ${toRevert.length} migration(s)`);
    return toRevert.length;
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
      } catch {
        // session teardown releases it
      }
    }
    client.release();
  }
}

function parseCliArgs(argv: string[]): RunDownOptions {
  const to = argv.find((a) => a.startsWith('--to='));
  const steps = argv.find((a) => a.startsWith('--steps='));
  return {
    steps: steps ? parseInt(steps.slice('--steps='.length), 10) || 1 : 1,
    to: to ? to.slice('--to='.length) : null,
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
  };
}

async function main(): Promise<void> {
  if (process.env.MIGRATE_ALLOW_DOWN !== '1') {
    console.error(
      '[migrate:down] refused: down migrations are gated. Set MIGRATE_ALLOW_DOWN=1 to run.\n' +
        'Production rollback is "re-deploy the previous tag", not a down migration (see DEPLOYMENT.md).',
    );
    process.exit(1);
  }
  try {
    await runDown(parseCliArgs(process.argv.slice(2)));
  } finally {
    await defaultPool.end().catch(() => undefined);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate:down]', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
