/**
 * Provenance, atomicity, and integrity helpers for the migration runner
 * (audit P3-3 / RC-23). Completes the P0-1 stop-gap in `migrationChecks.ts`.
 *
 * Every function here is PURE and content-injectable (no `fs`, no `pg`) so the
 * whole framework is unit-testable without a database — the same discipline as
 * `migrationChecks.ts`. The runner (`migrate.ts`) and the `migrate:verify` /
 * `migrate:down` CLIs are the only I/O-bound callers.
 *
 * Two invariants shape everything below and must never regress:
 *   1. The deployed `_migrations` table keys on FILENAME and contains rows for
 *      files that were later DELETED from disk (the offers branch 063/064/065,
 *      the 026/036 dupes — EV-037). Any check that reads on-disk content must
 *      treat an applied-but-absent row as legal forever (skip it, never fail).
 *   2. A fresh database and the deployed database must converge. A fresh DB
 *      never sees the orphan rows; the deployed one does. Nothing here may
 *      depend on the orphan rows being present OR absent.
 */
import { createHash } from 'node:crypto';
import { parseOrdinal } from './migrationChecks';

/** sha256 hex of a migration file's content, hashed exactly as the runner reads it (utf-8). */
export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

/** A `-- migrate:no-transaction` comment line anywhere in the file. */
const NO_TRANSACTION_RE = /^[ \t]*--[ \t]*migrate:no-transaction\b/im;

export interface MigrationAnnotations {
  /** The file opts out of the batch transaction — it runs standalone in autocommit. */
  noTransaction: boolean;
}

export function parseAnnotations(sql: string): MigrationAnnotations {
  return { noTransaction: NO_TRANSACTION_RE.test(sql) };
}

// ---------------------------------------------------------------------------
// Transaction-hostile SQL detection
// ---------------------------------------------------------------------------

/**
 * Replace SQL comments and string/dollar-quoted bodies with a space, so a token
 * scan sees only executable SQL. Without this, a `COMMIT` inside a `$block$…$`
 * prompt body (migration 063) or a `-- …` comment would false-positive.
 */
export function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = sql[i + 1];

    // line comment  -- … \n
    if (c === '-' && c2 === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    // block comment  /* … */
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // single-quoted string  '…'  ('' escapes a quote)
    if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      out += ' ';
      continue;
    }
    // dollar-quoted string  $tag$…$tag$  (tag may be empty: $$…$$)
    if (c === '$') {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        out += ' ';
        continue;
      }
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Statements that either self-commit or cannot run inside a transaction block.
 * In the per-file model (P0-1) a stray `COMMIT` was harmless; under the batch
 * transaction it commits the WHOLE batch early — silently reintroducing the
 * half-migrated schema P3-3 exists to eliminate. So a pending file containing
 * any of these MUST carry `-- migrate:no-transaction` (runs standalone).
 *
 * `BEGIN` excludes `BEGIN ATOMIC` (SQL-standard function bodies, which are legal
 * inside a transaction and are not a transaction-control statement).
 */
const HOSTILE_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'CREATE INDEX CONCURRENTLY', re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i },
  { label: 'DROP INDEX CONCURRENTLY', re: /\bDROP\s+INDEX\s+CONCURRENTLY\b/i },
  { label: 'REINDEX CONCURRENTLY', re: /\bREINDEX\b[^;]*\bCONCURRENTLY\b/i },
  { label: 'ALTER TYPE … ADD VALUE', re: /\bALTER\s+TYPE\b[^;]*\bADD\s+VALUE\b/i },
  { label: 'VACUUM', re: /\bVACUUM\b/i },
  { label: 'CREATE DATABASE', re: /\bCREATE\s+DATABASE\b/i },
  { label: 'DROP DATABASE', re: /\bDROP\s+DATABASE\b/i },
  { label: 'CREATE TABLESPACE', re: /\bCREATE\s+TABLESPACE\b/i },
  { label: 'DROP TABLESPACE', re: /\bDROP\s+TABLESPACE\b/i },
  { label: 'ALTER SYSTEM', re: /\bALTER\s+SYSTEM\b/i },
  { label: 'COMMIT', re: /\bCOMMIT\b/i },
  { label: 'ROLLBACK', re: /\bROLLBACK\b/i },
  { label: 'BEGIN', re: /\bBEGIN\b(?!\s+ATOMIC\b)/i },
];

/** The hostile-token labels present in a single migration's SQL (empty if clean). */
export function detectHostileTokens(sql: string): string[] {
  const stripped = stripSqlNoise(sql);
  return HOSTILE_PATTERNS.filter((p) => p.re.test(stripped)).map((p) => p.label);
}

/**
 * Preflight: any PENDING file with transaction-hostile SQL that is not annotated
 * `-- migrate:no-transaction`. Annotated files are skipped — they run standalone
 * (the annotation is the opt-out), so their hostile tokens are expected.
 */
export function findTransactionHostileFiles(
  pendingFiles: string[],
  readSql: (file: string) => string,
): string[] {
  const errors: string[] = [];
  for (const file of pendingFiles) {
    const sql = readSql(file);
    if (parseAnnotations(sql).noTransaction) continue;
    const tokens = detectHostileTokens(sql);
    if (tokens.length > 0) {
      errors.push(
        `migration ${file} contains transaction-hostile SQL (${tokens.join(', ')}) but is not ` +
          `annotated '-- migrate:no-transaction'. The runner applies pending files in one batch ` +
          `transaction; such statements self-commit or cannot run inside it — add the annotation ` +
          `so the file runs standalone (and keep it idempotent, e.g. CONCURRENTLY … IF NOT EXISTS).`,
      );
    }
  }
  return errors;
}

/**
 * Executable statements in a file, counted after `stripSqlNoise` (so semicolons inside comments,
 * string literals and dollar-quoted bodies don't count).
 */
export function countExecutableStatements(sql: string): number {
  return stripSqlNoise(sql)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

/**
 * Preflight: an annotated `-- migrate:no-transaction` file must hold EXACTLY ONE executable
 * statement. The runner executes an annotated file as one `client.query(sql)` in autocommit —
 * but node-postgres sends multi-statement text as a single simple-protocol message, which
 * Postgres wraps in an IMPLICIT transaction. Two statements therefore silently regain the
 * transaction the annotation opted out of, and a `CREATE INDEX CONCURRENTLY` among them fails at
 * apply time with "cannot run inside a transaction block".
 */
export function findMultiStatementNoTransactionFiles(
  pendingFiles: string[],
  readSql: (file: string) => string,
): string[] {
  const errors: string[] = [];
  for (const file of pendingFiles) {
    const sql = readSql(file);
    if (!parseAnnotations(sql).noTransaction) continue;
    const count = countExecutableStatements(sql);
    if (count > 1) {
      errors.push(
        `migration ${file} is annotated '-- migrate:no-transaction' but contains ${count} executable ` +
          `statements. node-postgres sends multi-statement text as ONE implicit transaction, so the ` +
          `annotation is silently defeated (and transaction-hostile statements inside it fail at ` +
          `apply time). Split it into one no-transaction file per statement.`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Checksum drift detection
// ---------------------------------------------------------------------------

export interface AppliedRow {
  name: string;
  /** null = not yet baselined (pre-P3-3 row) OR an orphan whose file is gone. */
  checksum: string | null;
}

/**
 * An applied migration whose on-disk bytes no longer match the checksum recorded
 * when it was applied — someone edited an already-applied file. Migrations are
 * immutable once applied; the edit never re-runs, so the schema and the file
 * silently disagree. `readSql` returns null for a file that no longer exists
 * (orphan row) — skipped, never flagged.
 */
export function findChecksumDrift(
  appliedRows: AppliedRow[],
  readSql: (file: string) => string | null,
): string[] {
  const errors: string[] = [];
  for (const row of appliedRows) {
    if (row.checksum === null) continue; // never baselined — nothing to compare
    const content = readSql(row.name);
    if (content === null) continue; // orphan — file deleted, legal forever
    const actual = sha256(content);
    if (actual !== row.checksum) {
      errors.push(
        `migration ${row.name} has DRIFTED: recorded ${row.checksum.slice(0, 12)}… ` +
          `!= on-disk ${actual.slice(0, 12)}…. An applied migration file was edited after it ran. ` +
          `Migrations are immutable once applied — revert the edit, or ship the change as a new migration.`,
      );
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Segment planning (batch transaction with no-transaction barriers)
// ---------------------------------------------------------------------------

export type Segment =
  | { kind: 'txn'; files: string[] }
  | { kind: 'notxn'; file: string };

/**
 * Group the ordered pending list into apply segments:
 *   - a maximal run of consecutive transactional files → ONE transaction,
 *   - each no-transaction file → its own autocommit segment, acting as a BARRIER
 *     that flushes the current transactional batch before it (files must apply
 *     in order — a later file may depend on an earlier one, so a no-transaction
 *     file cannot be reordered to the end).
 *
 * `perFile` degrades every transactional segment to size 1 (the pre-P3-3 /
 * MIGRATE_PER_FILE=1 behaviour); no-transaction files are unaffected.
 */
export function planSegments(
  pending: string[],
  isNoTransaction: (file: string) => boolean,
  perFile = false,
): Segment[] {
  const segments: Segment[] = [];
  let batch: string[] = [];
  const flush = () => {
    if (batch.length > 0) {
      segments.push({ kind: 'txn', files: batch });
      batch = [];
    }
  };

  for (const file of pending) {
    if (isNoTransaction(file)) {
      flush();
      segments.push({ kind: 'notxn', file });
    } else if (perFile) {
      flush();
      segments.push({ kind: 'txn', files: [file] });
    } else {
      batch.push(file);
    }
  }
  flush();
  return segments;
}

// ---------------------------------------------------------------------------
// Applied-order verification (migrate:verify)
// ---------------------------------------------------------------------------

export interface LedgerRow {
  name: string;
  applied_seq: number | null;
  /** whether the file still exists on disk (orphan rows are excluded from ordering) */
  onDisk: boolean;
}

/**
 * Among the migrations that STILL EXIST on disk, applied order (by `applied_seq`)
 * must be non-decreasing in ordinal. The orphan rows are excluded: the real
 * history applied 065_offers before 063_catalog_grounding (C-150), which is a
 * genuine, immutable out-of-order application — but every offers file is now
 * deleted, so the surviving set is monotonic. Equal ordinals (the 062 pair) pass.
 */
export function assertMonotonicApplied(rows: LedgerRow[]): string[] {
  const ordered = rows
    .filter((r) => r.onDisk && r.applied_seq !== null)
    .sort((a, b) => (a.applied_seq as number) - (b.applied_seq as number));

  const errors: string[] = [];
  let maxOrdinalSoFar: number | null = null;
  let maxName = '';
  for (const row of ordered) {
    const ord = parseOrdinal(row.name);
    if (ord === null) continue;
    if (maxOrdinalSoFar !== null && ord < maxOrdinalSoFar) {
      errors.push(
        `migration ${row.name} (ordinal ${ord}) was applied after ${maxName} (ordinal ` +
          `${maxOrdinalSoFar}) — applied order is not monotonic in the current on-disk set`,
      );
    }
    if (maxOrdinalSoFar === null || ord > maxOrdinalSoFar) {
      maxOrdinalSoFar = ord;
      maxName = row.name;
    }
  }
  return errors;
}

/**
 * The end-of-run reconcile SQL: fill `applied_seq` for rows that lack it,
 * continuing from the current max, in true apply order (`run_at, id`). Idempotent
 * — a run with no NULL `applied_seq` rows updates nothing. Runs single-writer
 * under the migration advisory lock, so the continue-from-max is race-free; the
 * partial unique index on `applied_seq` is a belt-and-suspenders guard.
 */
export function backfillAppliedSeqSql(): string {
  return `
    WITH base AS (SELECT COALESCE(MAX(applied_seq), 0) AS m FROM _migrations),
         ord AS (
           SELECT id, ROW_NUMBER() OVER (ORDER BY run_at ASC, id ASC) AS rn
             FROM _migrations
            WHERE applied_seq IS NULL
         )
    UPDATE _migrations t
       SET applied_seq = base.m + ord.rn
      FROM ord, base
     WHERE t.id = ord.id
  `.trim();
}
