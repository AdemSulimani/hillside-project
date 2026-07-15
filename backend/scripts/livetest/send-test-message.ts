/**
 * Live-test harness, step 2: drive ONE real message through the whole AI pipeline.
 *
 * WHAT THIS IS: a byte-identical Facebook Messenger webhook POST — same body shape, same
 * X-Hub-Signature-256 HMAC over the raw body — sent at the local backend. The app cannot tell it
 * from Meta. Nothing is mocked or stubbed; every flag in .env is live.
 *
 * WHY IT MATTERS: typecheck and unit tests pass on code that still breaks when it runs. This is the
 * only check that exercises the flags TOGETHER — the gate ladder, the P2-4 receipt snapshot, P2-1's
 * grounding gate, P2-2's order FSM, P2-3's history/cache, P1-1's outbox and staging — in one flow.
 *
 * WHERE IT STOPS: the outbound Graph API send fails (the seeded channel's token is fake), so you
 * get everything up to and including the decision ledger, then a `message_send_failed` alert. That
 * is ~95% of the pipeline and 100% of the part the audit found bugs in.
 *
 *   npx tsx scripts/livetest/send-test-message.ts ["your message here"]
 *
 * Requires the backend running (npm run dev) and the channel seeded (seed-test-channel.ts).
 */
import 'dotenv/config';
import crypto from 'crypto';
import { BACKEND, TEST_CONTACT_ID as CONTACT_ID, TEST_PAGE_ID } from './config';

/** A catalog question in Albanian — the core market, and what the audit's failures were about. */
const DEFAULT_TEXT = 'A keni Mega Mass 4000? Sa kushton?';

function buildBody(text: string, mid: string, tsMs: number): string {
  return JSON.stringify({
    object: 'page',
    entry: [
      {
        id: TEST_PAGE_ID,
        time: tsMs,
        messaging: [
          {
            sender: { id: CONTACT_ID },
            recipient: { id: TEST_PAGE_ID },
            timestamp: tsMs,
            message: { mid, text },
          },
        ],
      },
    ],
  });
}

async function post(rawBody: string, appSecret: string): Promise<{ status: number; body: string }> {
  const signature = `sha256=${crypto.createHmac('sha256', appSecret).update(Buffer.from(rawBody, 'utf8')).digest('hex')}`;
  const res = await fetch(`${BACKEND}/api/webhooks/facebook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body: rawBody,
  });
  return { status: res.status, body: await res.text() };
}

async function main(): Promise<void> {
  const appSecret = process.env.META_APP_SECRET;
  if (!appSecret) throw new Error('META_APP_SECRET is required to sign the payload');

  const text = process.argv[2] ?? DEFAULT_TEXT;
  const mid = `m_livetest_${Date.now()}`;
  const nowMs = Date.now();

  console.log(`[livetest] POST ${BACKEND}/api/webhooks/facebook`);
  console.log(`[livetest] mid=${mid}`);
  console.log(`[livetest] text="${text}"\n`);

  const fresh = await post(buildBody(text, mid, nowMs), appSecret);
  console.log(`[livetest] fresh delivery      -> HTTP ${fresh.status} ${fresh.body.slice(0, 60)}`);

  // RC-11 check 1: the SAME body replayed. Must be deduped by the webhook_seen claim (200, no
  // second job) — not processed twice.
  const replay = await post(buildBody(text, mid, nowMs), appSecret);
  console.log(`[livetest] identical replay    -> HTTP ${replay.status} (expect 200, deduped)`);

  // RC-11 check 2: a DIFFERENT message carrying a 6-minute-old timestamp. Under the legacy skew
  // gate this was 403'd into permanent silence; with WEBHOOK_DEDUPE_REPLAY on it is accepted.
  const lateMid = `m_livetest_late_${Date.now()}`;
  const late = await post(buildBody('A keni proteina?', lateMid, nowMs - 6 * 60_000), appSecret);
  const dedupeOn = (process.env.WEBHOOK_DEDUPE_REPLAY ?? 'false').toLowerCase() === 'true';
  console.log(
    `[livetest] 6-min-late delivery -> HTTP ${late.status} ` +
      `(expect ${dedupeOn ? '200 accepted — RC-11 fixed' : '403 dropped — legacy gate'})`,
  );

  console.log(`\n[livetest] ai.reply runs after AI_REPLY_DELAY_MS (${process.env.AI_REPLY_DELAY_MS ?? '8000'}ms).`);
  console.log('[livetest] then: npx tsx scripts/livetest/inspect-result.ts');
}

main().catch((err) => {
  console.error('[livetest] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
