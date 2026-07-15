/**
 * Live-test harness, step 1: seed a webhook-addressable test channel.
 *
 * WHY THIS EXISTS: the dev DB has tenants, a 257-product catalog and history, but ZERO channels —
 * so `resolveChannelByTypeAndExternalId` throws "Channel not found" and the AI pipeline cannot run
 * end-to-end at all. Nothing has ever flowed through it here (ai_decision_ledger is empty). This
 * seeds the one row that makes an inbound message routable.
 *
 * The channel is a FAKE: its access token is real encryption over a dummy value, so everything
 * upstream of the outbound Graph API call runs exactly as in production, and the final send fails
 * (401 from Meta). That is the intended boundary — it exercises gates, receipt snapshot, retrieval,
 * generation, guards, the ledger and order logic without touching a real customer.
 *
 * Safe to re-run: upserts on (tenant_id, type, external_id).
 *
 *   npx tsx scripts/livetest/seed-test-channel.ts
 */
import 'dotenv/config';
import pool from '../../src/db/pool';
import { cryptoService } from '../../src/services/cryptoService';
import { TEST_CHANNEL_TYPE, TEST_PAGE_ID, TEST_TENANT_NAME as TENANT_NAME } from './config';

async function main(): Promise<void> {
  const { rows: tenants } = await pool.query<{ id: string; name: string }>(
    'SELECT id, name FROM tenants WHERE name = $1 LIMIT 1',
    [TENANT_NAME],
  );
  const tenant = tenants[0];
  if (!tenant) throw new Error(`tenant "${TENANT_NAME}" not found`);

  // Real encryption over a dummy token: the decrypt path in processInboundMessage must succeed
  // (it decrypts before attachment fetch and before send), so a plaintext placeholder would fail
  // earlier and for the wrong reason.
  const token = cryptoService.encrypt('LIVETEST-FAKE-TOKEN-not-a-real-meta-token');

  const { rows } = await pool.query<{ id: string; ai_enabled: boolean }>(
    `INSERT INTO channels (tenant_id, type, name, external_id, access_token_encrypted,
                           webhook_verified, ai_enabled, connection_method)
     VALUES ($1, $2, $3, $4, $5, true, true, 'oauth_meta')
     ON CONFLICT (tenant_id, type, external_id)
       DO UPDATE SET access_token_encrypted = EXCLUDED.access_token_encrypted,
                     ai_enabled = true, webhook_verified = true, updated_at = now()
     RETURNING id, ai_enabled`,
    [tenant.id, TEST_CHANNEL_TYPE, 'LIVETEST Facebook Page', TEST_PAGE_ID, token],
  );

  console.log('[seed] channel ready');
  console.table([
    { tenant: tenant.name, tenantId: tenant.id, channelId: rows[0].id, pageId: TEST_PAGE_ID },
  ]);
  await pool.end();
}

main().catch((err) => {
  console.error('[seed] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
