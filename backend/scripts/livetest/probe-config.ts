/**
 * Live-test harness, step 0: which config is the RUNNING backend actually using?
 *
 * Flags are read at module load, so a server started before a .env edit keeps the old posture and
 * a test against it silently proves nothing. This probes behaviour rather than trusting the file:
 * a 6-minute-late signed delivery is 403'd by the legacy skew gate and accepted once
 * WEBHOOK_DEDUPE_REPLAY is live.
 *
 *   npx tsx scripts/livetest/probe-config.ts
 */
import 'dotenv/config';
import crypto from 'crypto';

const BACKEND = process.env.LIVETEST_BACKEND ?? `http://localhost:${process.env.PORT ?? '8000'}`;
const PAGE_ID = process.env.LIVETEST_PAGE_ID ?? '100000000000001';

async function main(): Promise<void> {
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error('META_APP_SECRET missing');

  const nowMs = Date.now();
  const body = JSON.stringify({
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: nowMs,
        messaging: [
          {
            sender: { id: '900000000000099' },
            recipient: { id: PAGE_ID },
            timestamp: nowMs - 6 * 60_000, // 6 minutes late
            message: { mid: `m_probe_${nowMs}`, text: 'probe' },
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

  const fileSays = (process.env.WEBHOOK_DEDUPE_REPLAY ?? 'false').toLowerCase() === 'true';
  const serverHasIt = res.status !== 403;

  console.log(`6-min-late signed delivery -> HTTP ${res.status}`);
  console.log(`  .env on disk says WEBHOOK_DEDUPE_REPLAY = ${fileSays}`);
  console.log(`  running server behaves as though it is  = ${serverHasIt}`);
  console.log(
    serverHasIt === fileSays
      ? '\nOK — the running server matches .env.'
      : '\nSTALE — the running server predates the .env edit. Restart it before testing, or the run proves nothing.',
  );
}

main().catch((err) => {
  console.error('[probe] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
