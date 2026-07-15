/**
 * Live-test harness: remove everything the harness created.
 *
 * Scoped strictly to the synthetic LIVETEST ids — it never touches real tenants, real contacts, or
 * the product catalog. Deletes children before parents so no FK is violated, and restores
 * ai_configs.is_active in case an rc06 run was interrupted before its own restore.
 *
 *   npx tsx scripts/livetest/cleanup.ts
 */
import 'dotenv/config';
import pool from '../../src/db/pool';
import { TEST_CHANNEL_TYPE, TEST_PAGE_ID, TEST_TENANT_NAME } from './config';

/** Every synthetic contact the harness can create (default flow + the rc06 toggle test). */
const CONTACT_IDS = ['900000000000001', '900000000000002', '900000000000099'];

async function main(): Promise<void> {
  const { rows: convs } = await pool.query<{ id: string }>(
    `SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.external_id = ANY($1::text[])`,
    [CONTACT_IDS],
  );
  const convIds = convs.map((c) => c.id);

  if (convIds.length) {
    for (const [label, sql] of [
      ['ai_decision_ledger', 'DELETE FROM ai_decision_ledger WHERE conversation_id = ANY($1::uuid[])'],
      ['ai_alerts', 'DELETE FROM ai_alerts WHERE conversation_id = ANY($1::uuid[])'],
      ['orders', 'DELETE FROM orders WHERE conversation_id = ANY($1::uuid[])'],
      ['ai_use_cases', 'DELETE FROM ai_use_cases WHERE conversation_id = ANY($1::uuid[])'],
      ['messages', 'DELETE FROM messages WHERE conversation_id = ANY($1::uuid[])'],
    ] as const) {
      const { rowCount } = await pool.query(sql, [convIds]);
      console.log(`  ${label}: ${rowCount ?? 0}`);
    }
    const { rowCount: c } = await pool.query('DELETE FROM conversations WHERE id = ANY($1::uuid[])', [convIds]);
    console.log(`  conversations: ${c ?? 0}`);
  }

  const { rowCount: ct } = await pool.query('DELETE FROM contacts WHERE external_id = ANY($1::text[])', [
    CONTACT_IDS,
  ]);
  console.log(`  contacts: ${ct ?? 0}`);

  const { rowCount: ch } = await pool.query(
    'DELETE FROM channels WHERE type = $1 AND external_id = $2',
    [TEST_CHANNEL_TYPE, TEST_PAGE_ID],
  );
  console.log(`  channels: ${ch ?? 0}`);

  // Safety net: an interrupted rc06 run could leave the tenant's AI switched off.
  const { rowCount: cfg } = await pool.query(
    `UPDATE ai_configs SET is_active = true, updated_at = now()
      WHERE tenant_id = (SELECT id FROM tenants WHERE name = $1) AND is_active = false`,
    [TEST_TENANT_NAME],
  );
  if (cfg) console.log(`  restored ai_configs.is_active=true for ${TEST_TENANT_NAME}`);

  console.log('\n[cleanup] done — dev DB is back to its pre-harness state');
  await pool.end();
}

main().catch((err) => {
  console.error('[cleanup] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
