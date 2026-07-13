/**
 * P1-6 (SEC-5 / OBS-7) one-off maintenance script: redact PII from existing `ai_alerts.details`.
 *
 * Going forward, `createAIAlert` redacts `details` at write time. This backfills rows written
 * before that landed. It applies the same `redactValue` pass unconditionally (independent of the
 * runtime REDACT_PII flag — running the backfill is itself the deliberate compliance action), and
 * is idempotent: a second run reports 0 changes because `redactPII` never re-masks a token.
 *
 * Usage:
 *   npm run redact-alert-details -- --dry-run
 *   npm run redact-alert-details
 *   npm run redact-alert-details -- --tenant-id=<uuid>
 */
import 'dotenv/config';
import pool from '../db/pool';
import { redactValue } from '../utils/redact';

type AlertDetailsRow = {
  id: string;
  tenant_id: string;
  details: Record<string, unknown>;
};

function parseArgs(argv: string[]) {
  const dryRun = argv.includes('--dry-run');
  const tenantArg = argv.find((arg) => arg.startsWith('--tenant-id='));
  const tenantId = tenantArg?.split('=')[1]?.trim() || undefined;
  return { dryRun, tenantId };
}

async function main(): Promise<void> {
  const { dryRun, tenantId } = parseArgs(process.argv.slice(2));

  const conditions = ['details IS NOT NULL'];
  const values: unknown[] = [];
  if (tenantId) {
    conditions.push('tenant_id = $1');
    values.push(tenantId);
  }

  const { rows } = await pool.query<AlertDetailsRow>(
    `SELECT id, tenant_id, details
       FROM ai_alerts
      WHERE ${conditions.join(' AND ')}`,
    values,
  );

  console.info(
    `Found ${rows.length} ai_alerts row(s) with details${tenantId ? ` for tenant ${tenantId}` : ''}.`,
  );

  let changedCount = 0;
  for (const row of rows) {
    const redacted = redactValue(row.details) as Record<string, unknown>;
    if (JSON.stringify(redacted) === JSON.stringify(row.details)) continue;

    changedCount += 1;
    console.info(`[redact] ${row.id}`);
    if (dryRun) continue;

    await pool.query(`UPDATE ai_alerts SET details = $2::jsonb WHERE id = $1`, [
      row.id,
      JSON.stringify(redacted),
    ]);
  }

  console.info(
    dryRun
      ? `Dry run complete. ${changedCount} row(s) would be redacted.`
      : `Redaction complete. ${changedCount} row(s) updated.`,
  );

  await pool.end();
}

main().catch((err) => {
  console.error('[redactAlertDetails] Failed', err);
  process.exit(1);
});
