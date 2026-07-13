/**
 * P1-2 step 5: dead-letter growth monitor + breaker + retention prune.
 *
 * Per-job exhaustion alerts (failureHandler) tell you a single job died. This monitor is the
 * distinct breaker for the *aggregate* signal: during an OpenAI/Redis incident many jobs dead-letter
 * at once, and we want ONE loud alert, not thousands — and we never want the table to grow unbounded.
 *
 * Each tick: log a backlog gauge; when the last hour's dead-letter count crosses
 * DLQ_ALERT_BURST_THRESHOLD, fire one aggregated alert (webhook + Sentry) until it recovers; and
 * prune already-actioned rows past DLQ_RETENTION_DAYS. Wired in server.ts behind DLQ_METRICS_ENABLED.
 */
import axios from 'axios';
import * as Sentry from '@sentry/node';
import { countDeadLetterMetrics, pruneReplayedDeadLetter } from '../db/models/deadLetter';

const CHECK_INTERVAL_MS = (() => {
  const n = parseInt(process.env.DLQ_METRICS_INTERVAL_MS ?? '60000', 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

const BURST_THRESHOLD = (() => {
  const n = parseInt(process.env.DLQ_ALERT_BURST_THRESHOLD ?? '25', 10);
  return Number.isFinite(n) && n > 0 ? n : 25;
})();

const RETENTION_DAYS = (() => {
  const n = parseInt(process.env.DLQ_RETENTION_DAYS ?? '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
})();

/** Track breaker state so we alert once per crossing, not every tick. */
let breakerTripped = false;

async function sendBurstAlert(recentHour: number, backlog: number): Promise<void> {
  Sentry.captureMessage('dead_letter growth burst', {
    level: 'warning',
    tags: { component: 'dead_letter' },
    extra: { recentHour, backlog, threshold: BURST_THRESHOLD },
  });

  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;

  const text = [
    `🔴 *Dead-letter burst*`,
    `\`${recentHour}\` jobs dead-lettered in the last hour (threshold \`${BURST_THRESHOLD}\`).`,
    `Backlog (un-actioned): \`${backlog}\`.`,
    `Likely an upstream incident (OpenAI / Redis / channel API). Investigate before replaying.`,
  ].join('\n');

  try {
    await axios.post(url, { text }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8_000,
      validateStatus: () => true,
    });
  } catch (err) {
    console.error('[dlq-monitor] Failed to post burst alert', { err });
  }
}

async function tick(): Promise<void> {
  try {
    const { backlog, recentHour } = await countDeadLetterMetrics();
    console.info('[dlq-monitor]', { backlog, recentHour, threshold: BURST_THRESHOLD });

    if (recentHour >= BURST_THRESHOLD) {
      if (!breakerTripped) {
        breakerTripped = true;
        await sendBurstAlert(recentHour, backlog);
      }
    } else {
      // Recovered — re-arm so the next burst alerts again.
      breakerTripped = false;
    }

    const pruned = await pruneReplayedDeadLetter(RETENTION_DAYS);
    if (pruned > 0) {
      console.info('[dlq-monitor] pruned actioned dead-letter rows', { pruned, retentionDays: RETENTION_DAYS });
    }
  } catch (err) {
    // Never crash the server over a monitoring call.
    console.warn('[dlq-monitor] tick failed', { err });
  }
}

let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function startDeadLetterMonitor(): void {
  if (monitorInterval) return;
  void tick();
  monitorInterval = setInterval(() => void tick(), CHECK_INTERVAL_MS);
  console.info('[dlq-monitor] Started', {
    intervalMs: CHECK_INTERVAL_MS,
    burstThreshold: BURST_THRESHOLD,
    retentionDays: RETENTION_DAYS,
  });
}

export function stopDeadLetterMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
