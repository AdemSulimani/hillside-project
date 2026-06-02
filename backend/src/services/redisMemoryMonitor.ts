/**
 * Redis memory monitor
 *
 * After switching to `noeviction` the safe failure mode under memory pressure
 * is a rejected SET command (cache misses, not lost jobs). But that's only
 * safe if we *know* pressure is building and can respond — either by scaling
 * the Redis instance or investigating which tenant is caching unusually large
 * payloads.
 *
 * This module runs a periodic check (default every 60 seconds) and posts to
 * ALERT_WEBHOOK_URL when used memory crosses WARNING_PCT (default 80%) or
 * CRITICAL_PCT (default 90%) of maxmemory. It reuses the same webhook format
 * as the BullMQ failure handler so alerts land in the same Slack/Discord channel.
 *
 * Wired in server.ts — call startRedisMemoryMonitor() once on boot.
 */
import axios from 'axios';
import { redisConnection } from '../jobs/redisConnection';

const CHECK_INTERVAL_MS = (() => {
  const n = parseInt(process.env.REDIS_MEMORY_CHECK_INTERVAL_MS ?? '60000', 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

const WARNING_PCT = (() => {
  const n = parseFloat(process.env.REDIS_MEMORY_WARNING_PCT ?? '80');
  return Number.isFinite(n) && n > 0 ? n : 80;
})();

const CRITICAL_PCT = (() => {
  const n = parseFloat(process.env.REDIS_MEMORY_CRITICAL_PCT ?? '90');
  return Number.isFinite(n) && n > 0 ? n : 90;
})();

/** Track last-sent alert level to avoid flooding the webhook on every tick. */
let lastAlertLevel: 'ok' | 'warning' | 'critical' = 'ok';

function parseInfoSection(info: string, field: string): number | null {
  const match = info.match(new RegExp(`^${field}:(\\d+)`, 'm'));
  if (!match) return null;
  return parseInt(match[1], 10);
}

async function sendAlert(level: 'warning' | 'critical', usedMb: number, maxMb: number, usedPct: number): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) return;

  const emoji = level === 'critical' ? '🔴' : '🟡';
  const text = [
    `${emoji} *Redis memory ${level.toUpperCase()}*`,
    `Used: \`${usedMb.toFixed(1)} MB\` / \`${maxMb.toFixed(1)} MB\` (${usedPct.toFixed(1)}%)`,
    `Policy: \`noeviction\` — cache SET commands will start failing above maxmemory.`,
    level === 'critical'
      ? '⚠️ *Immediate action required* — scale Redis or reduce cache load.'
      : 'Consider scaling Redis or checking for unusually large cached payloads.',
  ].join('\n');

  try {
    await axios.post(url, { text }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 8_000,
      validateStatus: () => true,
    });
  } catch (err) {
    console.error('[redis-monitor] Failed to post alert', { err });
  }
}

async function checkMemory(): Promise<void> {
  try {
    const info: string = await redisConnection.info('memory');

    const usedBytes = parseInfoSection(info, 'used_memory_rss');
    const maxBytes = parseInfoSection(info, 'maxmemory');

    if (!usedBytes || !maxBytes || maxBytes === 0) {
      // maxmemory = 0 means unlimited — nothing to alert on.
      return;
    }

    const usedMb = usedBytes / 1024 / 1024;
    const maxMb = maxBytes / 1024 / 1024;
    const usedPct = (usedBytes / maxBytes) * 100;

    console.info('[redis-monitor]', {
      usedMb: usedMb.toFixed(1),
      maxMb: maxMb.toFixed(1),
      usedPct: usedPct.toFixed(1),
    });

    if (usedPct >= CRITICAL_PCT) {
      if (lastAlertLevel !== 'critical') {
        lastAlertLevel = 'critical';
        await sendAlert('critical', usedMb, maxMb, usedPct);
      }
    } else if (usedPct >= WARNING_PCT) {
      if (lastAlertLevel === 'ok') {
        lastAlertLevel = 'warning';
        await sendAlert('warning', usedMb, maxMb, usedPct);
      }
    } else {
      // Back below warning — reset so the next threshold crossing fires again.
      lastAlertLevel = 'ok';
    }
  } catch (err) {
    // Never crash the server over a monitoring call.
    console.warn('[redis-monitor] Memory check failed', { err });
  }
}

let monitorInterval: ReturnType<typeof setInterval> | null = null;

export function startRedisMemoryMonitor(): void {
  if (monitorInterval) return;
  // Run once immediately so we have a baseline in the logs on startup.
  void checkMemory();
  monitorInterval = setInterval(() => void checkMemory(), CHECK_INTERVAL_MS);
  console.info('[redis-monitor] Started', {
    intervalMs: CHECK_INTERVAL_MS,
    warningPct: WARNING_PCT,
    criticalPct: CRITICAL_PCT,
  });
}

export function stopRedisMemoryMonitor(): void {
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
}
