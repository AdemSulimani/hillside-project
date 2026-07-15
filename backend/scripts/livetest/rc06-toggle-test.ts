/**
 * Live-test harness: the RC-06 acceptance test, run for real.
 *
 * THE SCENARIO (16-remediation-plan.md:388): "toggle AI off between a message's receipt and its
 * run → processed under the receipt snapshot; the ledger records it."
 *
 * A customer message arrives while the AI is ON. The merchant switches the AI off during the 8s
 * AI_REPLY_DELAY_MS window. The job then runs and drops the message.
 *
 * WHAT MUST BE TRUE:
 *   1. The message is still SUPPRESSED — the live gate governs. The snapshot must never override a
 *      merchant's switch. (Record-only: see services/receiptSnapshot.ts.)
 *   2. An ARTIFACT now exists saying so. Before this change the drop was a bare `return` + a
 *      console line: the message vanished with nothing durable to explain why. That silence IS
 *      RC-06's stated defect — "no artifact that a received message was discarded".
 *
 * Restores is_active=true on exit, including on failure.
 *
 *   npx tsx scripts/livetest/rc06-toggle-test.ts
 */
import 'dotenv/config';
import crypto from 'crypto';
import pool from '../../src/db/pool';

const BACKEND = process.env.LIVETEST_BACKEND ?? `http://localhost:${process.env.PORT ?? '8000'}`;
const PAGE_ID = process.env.LIVETEST_PAGE_ID ?? '100000000000001';
const CONTACT_ID = '900000000000002'; // distinct contact → its own conversation
const TENANT_NAME = process.env.LIVETEST_TENANT ?? 'ProteinPluss';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function setAiActive(tenantId: string, active: boolean): Promise<void> {
  await pool.query('UPDATE ai_configs SET is_active = $2, updated_at = now() WHERE tenant_id = $1', [
    tenantId,
    active,
  ]);
}

async function main(): Promise<void> {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error('META_APP_SECRET missing');

  const { rows: t } = await pool.query<{ id: string }>('SELECT id FROM tenants WHERE name = $1', [
    TENANT_NAME,
  ]);
  const tenantId = t[0]?.id;
  if (!tenantId) throw new Error(`tenant ${TENANT_NAME} not found`);

  try {
    await setAiActive(tenantId, true);
    console.log('[rc06] AI is ON — sending a message the customer is entitled to an answer to');

    const mid = `m_rc06_${Date.now()}`;
    const nowMs = Date.now();
    const body = JSON.stringify({
      object: 'page',
      entry: [
        {
          id: PAGE_ID,
          time: nowMs,
          messaging: [
            {
              sender: { id: CONTACT_ID },
              recipient: { id: PAGE_ID },
              timestamp: nowMs,
              message: { mid, text: 'Sa kushton Serious Mass?' },
            },
          ],
        },
      ],
    });
    const sig = `sha256=${crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex')}`;
    const res = await fetch(`${BACKEND}/api/webhooks/facebook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig },
      body,
    });
    console.log(`[rc06] webhook accepted -> HTTP ${res.status} (snapshot captured: aiActive=true)`);

    // Inside the 8s window: the merchant hits the switch.
    await sleep(3_000);
    await setAiActive(tenantId, false);
    console.log('[rc06] t+3s: merchant switched the AI OFF (message already received)');

    console.log('[rc06] waiting for the job to run and drop it...');
    await sleep(20_000);

    const { rows: msgs } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
        WHERE ct.external_id = $1 AND m.direction = 'outbound'`,
      [CONTACT_ID],
    );
    const replied = Number(msgs[0].n) > 0;

    const { rows: led } = await pool.query(
      `SELECT reply_slot, decision_kind,
              receipt_snapshot->'diverged' AS diverged,
              receipt_snapshot->'captured'->>'aiActive' AS captured_ai_active,
              receipt_snapshot->'live'->>'aiActive'     AS live_ai_active,
              receipt_snapshot->>'capture_to_eval_ms'   AS window_ms,
              guard_verdicts->>'outcome' AS outcome
         FROM ai_decision_ledger l
         JOIN conversations c ON c.id = l.conversation_id
         JOIN contacts ct ON ct.id = c.contact_id
        WHERE ct.external_id = $1 AND l.receipt_snapshot IS NOT NULL
        ORDER BY l.created_at DESC LIMIT 3`,
      [CONTACT_ID],
    );

    console.log('\n================ RESULT ================');
    console.log(`1. Message suppressed (live gate governs)? ${!replied ? 'YES — correct' : 'NO — REGRESSION'}`);
    console.log(`2. Artifact recorded?                      ${led.length > 0 ? 'YES — RC-06 closed' : 'NO — still silent'}`);
    if (led.length) console.table(led);
    console.log('========================================');
  } finally {
    await setAiActive(tenantId, true);
    console.log('\n[rc06] restored is_active=true');
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[rc06] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
