/**
 * Live-test harness, step 3: report what the pipeline ACTUALLY did with the test message.
 *
 * Reads the durable artifacts rather than trusting the logs: the persisted messages, the decision
 * ledger (prompt/model/usage/retrieval/facts_used/receipt_snapshot), any alerts, and any order.
 * This is the Phase-15 §15.2 "reconstruct the turn from the ledger alone" check, run for real.
 *
 *   npx tsx scripts/livetest/inspect-result.ts
 */
import 'dotenv/config';
import pool from '../../src/db/pool';

import { TEST_CONTACT_ID as CONTACT_ID } from './config';

function heading(s: string): void {
  console.log(`\n${'='.repeat(78)}\n${s}\n${'='.repeat(78)}`);
}

async function main(): Promise<void> {
  const { rows: convs } = await pool.query<{ id: string; tenant_id: string; ai_paused: boolean }>(
    `SELECT c.id, c.tenant_id, c.ai_paused
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id
      WHERE ct.external_id = $1 ORDER BY c.last_message_at DESC NULLS LAST LIMIT 1`,
    [CONTACT_ID],
  );
  const conv = convs[0];
  if (!conv) {
    console.log('No conversation for the test contact yet — did the webhook reach the backend?');
    await pool.end();
    return;
  }

  heading('MESSAGES (what the customer sent, what the AI produced)');
  const { rows: msgs } = await pool.query(
    `SELECT direction, sent_by, type, left(coalesce(content,''), 160) AS content,
            flagged, flag_reason, quality_score, created_at
       FROM messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 6`,
    [conv.id],
  );
  console.table(msgs);

  heading('DECISION LEDGER (P2-4: can we reconstruct the turn from this alone?)');
  const { rows: ledger } = await pool.query(
    `SELECT reply_slot, decision_kind,
            model->>'requested' AS model_requested,
            model->>'served'    AS model_served,
            model->>'temperature' AS temp,
            model->>'seed'      AS seed,
            usage->>'total_tokens' AS tokens,
            usage->>'calls_usd_cost' AS usd_all_calls,
            usage->>'call_count' AS openai_calls,
            retrieval->>'semantic_skipped' AS semantic_skipped,
            retrieval->>'threshold' AS threshold,
            jsonb_array_length(coalesce(facts_used,'[]'::jsonb)) AS facts_declared,
            receipt_snapshot->'diverged' AS snapshot_diverged,
            receipt_snapshot->>'capture_to_eval_ms' AS capture_to_eval_ms,
            created_at
       FROM ai_decision_ledger WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 6`,
    [conv.id],
  );
  console.table(ledger);

  if (ledger.length === 0) {
    console.log('!! ZERO ledger rows — the ledger did not record this turn.');
  }

  heading('FACTS_USED (P2-4 Part 2 / P2-1: what the model declared it used)');
  const { rows: facts } = await pool.query(
    `SELECT reply_slot, jsonb_pretty(facts_used) AS facts_used
       FROM ai_decision_ledger
      WHERE conversation_id = $1 AND facts_used IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [conv.id],
  );
  console.log(facts[0]?.facts_used ?? '(none recorded — facts_used is NULL on every row)');

  heading('RECEIPT SNAPSHOT (P2-4 Part 2 / RC-06)');
  const { rows: snaps } = await pool.query(
    `SELECT reply_slot, decision_kind, jsonb_pretty(receipt_snapshot) AS snapshot
       FROM ai_decision_ledger
      WHERE conversation_id = $1 AND receipt_snapshot IS NOT NULL
      ORDER BY created_at DESC LIMIT 2`,
    [conv.id],
  );
  if (snaps.length === 0) {
    console.log('(no snapshot rows — expected unless a gate dropped the message)');
  } else {
    for (const s of snaps) console.log(`${s.reply_slot} / ${s.decision_kind}:\n${s.snapshot}`);
  }

  heading('ALERTS / ORDERS / CONVERSATION STATE');
  const { rows: alerts } = await pool.query(
    `SELECT reason, status, fail_closed, created_at FROM ai_alerts
      WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 5`,
    [conv.id],
  );
  console.table(alerts);
  const { rows: orders } = await pool.query(
    `SELECT product_name, quantity, total_price, status, is_commissionable, commission_amount
       FROM orders WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 3`,
    [conv.id],
  );
  console.table(orders.length ? orders : [{ note: 'no order (expected for a question)' }]);
  console.log(`conversation ai_paused = ${conv.ai_paused}`);

  await pool.end();
}

main().catch((err) => {
  console.error('[inspect] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
