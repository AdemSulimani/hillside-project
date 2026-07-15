/**
 * P2-7 — `npm run config:check`: the CONFIG GATE. This is the program that fails.
 *
 * WHY THIS IS A SEPARATE PROGRAM FROM `validateEnv`.
 * P2-7's stated risk is that "a strict assertion WILL refuse to start a mis-set deploy" — which is
 * exactly what you want in CI and exactly what you do NOT want on a running fleet, where it turns a
 * silently-degraded-but-serving container into a hard outage at the next restart. Splitting the
 * escalation out of the boot path means both can be true at once:
 *
 *   validateEnv (boot)     — warns loudly, starts. Fatal only for missing-required, a
 *                            wrong-dimension embedding model, and production secret hygiene.
 *   checkConfig (CI/pre-deploy) — same detector, strict: any violation exits 1.
 *
 * `ci.yml` runs it twice, deliberately differently:
 *   - `backend` job:       `--source=env-example`  (offline; no DB, no secrets; every PR)
 *   - `backend-smoke` job: `--strict`              (real env + the DB dimension probe)
 *
 * Usage:
 *   npm run config:check                      # strict check of the current env (DB probe if reachable)
 *   npm run config:check -- --source=env-example
 *   npm run config:check -- --no-db           # skip the DB probe
 *   npm run config:check -- --json            # machine-readable
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Finding,
  applyMode,
  detect,
  detectExampleDrift,
  fingerprint,
} from '../config/knobs';
import { EMBEDDING_COLUMN_TABLES, EXPECTED_EMBEDDING_DIM, resolveModel } from '../config/models';

interface Args {
  sourceEnvExample: boolean;
  json: boolean;
  db: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    sourceEnvExample: argv.includes('--source=env-example'),
    json: argv.includes('--json'),
    db: !argv.includes('--no-db'),
  };
}

/**
 * Guard 1's authoritative half: read the REAL declared dimension of every embedding column.
 *
 * `information_schema.columns` cannot answer this — for an extension type it reports
 * `data_type='USER-DEFINED'`, `udt_name='vector'` and a NULL length, with the dimension nowhere in
 * sight. pgvector stores the dimension in `pg_attribute.atttypmod`, so that is the only source.
 * (P2-7's spec says "read the column dimension from information_schema"; that is not achievable —
 * see the plan's spec-corrections.)
 *
 * This is why the check is a CLI and not a boot assertion: `validateEnv` is synchronous and holds no
 * pool, and giving it one would make every entrypoint that merely imports config open a database
 * connection.
 */
async function checkColumnDimensions(): Promise<Finding[]> {
  const { default: pool } = await import('../db/pool');
  const findings: Finding[] = [];

  const { rows } = await pool.query<{ table_name: string; declared: string; dim: number }>(
    `SELECT c.relname AS table_name,
            format_type(a.atttypid, a.atttypmod) AS declared,
            a.atttypmod AS dim
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = ANY($1::text[])
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped`,
    [[...EMBEDDING_COLUMN_TABLES]],
  );

  if (rows.length === 0) {
    findings.push({
      key: 'OPENAI_EMBEDDING_MODEL',
      code: 'unknown_model',
      effective: null,
      message: 'no embedding columns found — run migrations before checking dimensions',
    });
    return findings;
  }

  for (const row of rows) {
    // Catches the constant rotting against the schema: if a migration ever re-declares the column,
    // EXPECTED_EMBEDDING_DIM must move with it, and this is what notices.
    if (row.dim !== EXPECTED_EMBEDDING_DIM) {
      findings.push({
        key: 'OPENAI_EMBEDDING_MODEL',
        code: 'dimension_mismatch',
        effective: String(row.dim),
        message: `${row.table_name}.embedding is ${row.declared}, but EXPECTED_EMBEDDING_DIM in config/models.ts is ${EXPECTED_EMBEDDING_DIM}. The code and the schema disagree about the vector width.`,
      });
    }
  }

  const model = resolveModel('embedding');
  if (model && rows.length > 0) {
    console.log(
      `[config:check] embedding columns verified against the live schema: ` +
        rows.map((r) => `${r.table_name}.embedding=${r.declared}`).join(', ') +
        ` (model=${model})`,
    );
  }

  await pool.end();
  return findings;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.sourceEnvExample) {
    const path = resolve(__dirname, '../../.env.example');
    const findings = detectExampleDrift(readFileSync(path, 'utf8'));

    if (args.json) {
      console.log(JSON.stringify({ mode: 'env-example', findings }, null, 2));
    } else if (findings.length === 0) {
      console.log('[config:check] .env.example documents every knob in the manifest, with matching defaults. OK');
    } else {
      console.error(`[config:check] .env.example has drifted from config/knobs.ts (${findings.length} issue(s)):`);
      for (const f of findings) console.error(`  - [${f.code}] ${f.message}`);
      console.error(
        '\nFix by adding the missing keys to backend/.env.example (or correcting the value shown there).\n' +
          'An undocumented knob is one an operator cannot know exists; a mismatched one is worse — it\n' +
          'makes the example a trap, because an env built from it behaves differently from one without it.',
      );
    }
    process.exit(findings.length === 0 ? 0 : 1);
  }

  // Strict env check. Unlike validateEnv, this one escalates.
  let findings = applyMode(detect(process.env), 'strict', process.env.NODE_ENV === 'production');

  if (args.db) {
    try {
      const dimFindings = await checkColumnDimensions();
      findings = findings.concat(applyMode(dimFindings, 'strict', false));
    } catch (err) {
      console.warn(`[config:check] skipped the DB dimension probe: ${(err as Error).message}`);
    }
  }

  const fatal = findings.filter((f) => f.severity === 'fatal');
  const warn = findings.filter((f) => f.severity === 'warn');
  const fp = fingerprint(process.env);

  if (args.json) {
    console.log(JSON.stringify({ mode: 'strict', fingerprint: fp.hash, fatal, warn }, null, 2));
  } else {
    console.log(`[config:check] config fingerprint ${fp.hash} (${Object.keys(fp.knobs).length} frozen knobs)`);
    for (const f of warn) console.warn(`  ! [${f.code}] ${f.message}`);
    for (const f of fatal) console.error(`  x [${f.code}] ${f.message}`);
    console.log(
      fatal.length === 0
        ? `[config:check] OK — no violations${warn.length > 0 ? ` (${warn.length} advisory warning(s))` : ''}`
        : `[config:check] FAILED — ${fatal.length} violation(s)`,
    );
  }

  process.exit(fatal.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[config:check] unexpected error:', err);
  process.exit(1);
});
