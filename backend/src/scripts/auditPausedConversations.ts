/**
 * P0-5 (RC-14) operator report: conversations paused with NO recorded reason.
 *
 * Migration 069 added `ai_paused_reason` / `ai_paused_at`; every pause written since is stamped.
 * Rows paused BEFORE it carry NULL in both — and AI_AUTO_RESUME deliberately never touches a
 * NULL-reason pause (an unknown reason must not be auto-resumed), so these rows are permanent
 * silence unless a human resolves them. The P0-P3 dev validation (2026-07-20, Finding 1) requires
 * a one-time operator review of exactly this population at P0-5 production enablement.
 *
 * READ-ONLY. Reasons are unrecoverable — this script reports; it never backfills. Always exits 0
 * (it is an operator report backing a review, not a CI gate).
 *
 * Two buckets, reported separately:
 *   (a) `ai_paused_at IS NULL`     — the pre-069 legacy population (plus any reason-less manual
 *                                    toggle path); Finding 1's rows live here.
 *   (b) `ai_paused_at IS NOT NULL` — should be EMPTY post-069: a stamped pause without a reason
 *                                    means a write path is dropping the reason. Flagged loudly.
 *
 * Usage:
 *   npm run audit-paused-conversations
 *   npm run audit-paused-conversations -- --tenant-id=<uuid>
 *   npm run audit-paused-conversations -- --json
 */
import 'dotenv/config';
import pool from '../db/pool';

type NullReasonPauseRow = {
  id: string;
  tenant_id: string;
  ai_paused_at: string | null;
  updated_at: string;
  has_newer_inbound: boolean;
};

const SAMPLE_LIMIT = 10;

function parseArgs(argv: string[]) {
  const json = argv.includes('--json');
  const tenantArg = argv.find((arg) => arg.startsWith('--tenant-id='));
  const tenantId = tenantArg?.split('=')[1]?.trim() || undefined;
  return { json, tenantId };
}

async function main(): Promise<void> {
  const { json, tenantId } = parseArgs(process.argv.slice(2));

  const conditions = ['c.ai_paused = TRUE', 'c.ai_paused_reason IS NULL'];
  const values: unknown[] = [];
  if (tenantId) {
    conditions.push('c.tenant_id = $1');
    values.push(tenantId);
  }

  // `has_newer_inbound` is the "permanent silence" signal: a customer wrote after the pause and
  // the AI can never answer. SQL shape mirrors findPauseInvariantViolations (conversation.ts),
  // but the population is the COMPLEMENT of that check's (NULL reason, not stamped-but-stuck).
  const { rows } = await pool.query<NullReasonPauseRow>(
    `SELECT c.id,
            c.tenant_id,
            c.ai_paused_at,
            c.updated_at,
            EXISTS (
              SELECT 1 FROM messages m
               WHERE m.conversation_id = c.id
                 AND m.direction = 'inbound'
                 AND m.created_at > c.updated_at
            ) AS has_newer_inbound
       FROM conversations c
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.tenant_id, c.updated_at`,
    values,
  );

  const legacy = rows.filter((r) => r.ai_paused_at === null);
  const stampedButReasonless = rows.filter((r) => r.ai_paused_at !== null);

  if (json) {
    console.info(
      JSON.stringify(
        {
          total: rows.length,
          legacy_pre069: legacy,
          stamped_but_reasonless: stampedButReasonless,
        },
        null,
        2,
      ),
    );
    await pool.end();
    return;
  }

  console.info(
    `[audit-paused] ${rows.length} conversation(s) paused with NULL ai_paused_reason` +
      `${tenantId ? ` for tenant ${tenantId}` : ''}.`,
  );

  const byTenant = new Map<string, NullReasonPauseRow[]>();
  for (const row of legacy) {
    const list = byTenant.get(row.tenant_id) ?? [];
    list.push(row);
    byTenant.set(row.tenant_id, list);
  }

  console.info(`\nBucket (a) — legacy pre-069 (ai_paused_at IS NULL): ${legacy.length} row(s).`);
  console.info(
    'These are permanent-silence dead-ends (RC-14): AI_AUTO_RESUME never resumes an unknown',
  );
  console.info(
    'reason. Review each — resolve the underlying thread and unpause, or leave paused deliberately.',
  );
  for (const [tenant, list] of byTenant) {
    const silent = list.filter((r) => r.has_newer_inbound).length;
    console.info(
      `  tenant ${tenant}: ${list.length} row(s), ${silent} with a newer unanswered inbound`,
    );
    for (const row of list.slice(0, SAMPLE_LIMIT)) {
      console.info(
        `    ${row.id} last-updated ${row.updated_at}` +
          `${row.has_newer_inbound ? '  ⚠ customer wrote after the pause' : ''}`,
      );
    }
    if (list.length > SAMPLE_LIMIT) {
      console.info(`    … ${list.length - SAMPLE_LIMIT} more (use --json for the full list)`);
    }
  }

  if (stampedButReasonless.length > 0) {
    console.info(
      `\n⚠⚠ Bucket (b) — STAMPED pause with NULL reason (ai_paused_at IS NOT NULL): ` +
        `${stampedButReasonless.length} row(s). This should be EMPTY after migration 069 — a` +
        ` pause write path is dropping the reason. Investigate before P0-5 enablement.`,
    );
    for (const row of stampedButReasonless.slice(0, SAMPLE_LIMIT)) {
      console.info(`    ${row.id} tenant ${row.tenant_id} paused-at ${row.ai_paused_at}`);
    }
  } else {
    console.info('\nBucket (b) — stamped-but-reasonless: 0 rows (expected post-069 state).');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[auditPausedConversations] Failed', err);
  process.exit(1);
});
