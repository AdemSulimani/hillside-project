import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pool from './pool';
import { runMigrationChecks } from './migrationChecks';

// Arbitrary constant identifying "the Hillside migration run" cluster-wide.
// Session-level advisory lock: concurrent runners (deploy pre-up, container
// boots, replicas) serialize instead of racing; the session releases it on
// disconnect even if the process dies. Would not survive a move to PgBouncer
// transaction pooling.
const MIGRATION_LOCK_KEY = '815051262';

async function migrate() {
  const client = await pool.connect();
  let locked = false;

  try {
    // Take the lock before touching _migrations so even two fresh boots
    // racing the CREATE TABLE serialize.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id      SERIAL PRIMARY KEY,
        name    VARCHAR(255) NOT NULL UNIQUE,
        run_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
      );
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const applied = new Set<string>(
      (await client.query('SELECT name FROM _migrations')).rows.map(
        (row: { name: string }) => row.name,
      ),
    );

    // Fail fast on duplicate ordinals / out-of-order pending files before
    // anything is applied. Hard failure only under MIGRATE_STRICT=1 (CI and
    // the pre-deploy run) so an anomaly that slips through can never brick
    // the boot loop in production, where this also runs on every start.
    const violations = runMigrationChecks(files, applied);
    if (violations.length > 0) {
      if (process.env.MIGRATE_STRICT === '1') {
        throw new Error(
          `[migrate] Preflight checks failed:\n${violations.join('\n')}`,
        );
      }
      for (const violation of violations) {
        console.warn('[migrate] WARNING (non-strict mode):', violation);
      }
    }

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] Skipping ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`[migrate] Applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
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
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error('[migrate] Migration failed:', err);
  process.exit(1);
});
