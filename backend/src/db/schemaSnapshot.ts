/**
 * P3-3 helper: print a stable, version-independent fingerprint of the public
 * schema (every table's columns + types) to stdout, one `table.column:type` per
 * line, sorted. Used by the CI `migration-shape` job to assert an up/down/up
 * round-trip converges to an identical schema — cheaper and more portable than a
 * `pg_dump --schema-only` diff (no client/server major-version coupling).
 *
 *   node dist/db/schemaSnapshot.js > before.txt
 */
import 'dotenv/config';
import pool from './pool';

async function main(): Promise<void> {
  const { rows } = await pool.query<{ sig: string }>(
    `SELECT table_name || '.' || column_name || ':' || data_type AS sig
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY 1`,
  );
  process.stdout.write(rows.map((r) => r.sig).join('\n') + '\n');
  await pool.end().catch(() => undefined);
}

main().catch((err) => {
  console.error('[schema-snapshot]', err);
  process.exit(1);
});
