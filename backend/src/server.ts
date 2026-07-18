import './bootstrap';
import './instrument';
import http from 'http';
import app from './app';
import {
  webhookWorker,
  aiWorker,
  notificationsWorker,
  finetuningWorker,
  defaultWorker,
} from './jobs/workers';
import { initSocketServer } from './sockets';
import { startRedisMemoryMonitor, stopRedisMemoryMonitor } from './services/redisMemoryMonitor';
import { startDeadLetterMonitor, stopDeadLetterMonitor } from './services/deadLetterMonitor';
import { startLedgerRetention, stopLedgerRetention } from './services/ledgerRetention';
import { recordConfigFingerprintBestEffort } from './jobs/configFingerprintRegistry';
import { knobNumber } from './config/knobs';

/**
 * P2-7: the code default was 3000 while `.env.example`, docker-compose, BACKEND_URL, CI and
 * CLAUDE.md §10 all say 8000 — a documented-vs-code drift that only hid because every deployment
 * path happens to set PORT explicitly. Reconciled to 8000 (the documented value) and read through
 * the manifest so the two cannot diverge again.
 */
const PORT = knobNumber('PORT');

/** P1-2 step 5: dead-letter growth monitor (off by default). */
const DLQ_METRICS_ENABLED = (process.env.DLQ_METRICS_ENABLED ?? 'false').trim().toLowerCase() === 'true';

// P2-4 (F6): the retention sweep is deliberately NOT tied to AI_DECISION_LEDGER_ENABLED. Rows
// written during a flag-on period are customer-derived data with a GDPR retention obligation that
// does not end when recording stops — gating the sweep on the recording flag stranded them
// unpruned indefinitely. The sweep on an empty/absent-backlog table is one cheap indexed DELETE
// per tick, so running it unconditionally costs nothing when the ledger was never enabled.

const httpServer = http.createServer(app);
initSocketServer(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[server] Running in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`[server] Listening on http://localhost:${PORT}`);
  startRedisMemoryMonitor();
  if (DLQ_METRICS_ENABLED) startDeadLetterMonitor();
  startLedgerRetention();
  // P2-7 guard 7: publish this instance's config fingerprint so a drifted fleet is detectable.
  // Deliberately after listen and deliberately not awaited — it is best-effort telemetry, and a
  // slow or unavailable database must not delay serving traffic.
  void recordConfigFingerprintBestEffort();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
//
// Without this, Docker sends SIGTERM on every deploy and the Node process exits
// immediately. Any BullMQ job that is mid-execution (AI reply being generated,
// embedding running) is abandoned and marked "stalled". With this handler:
//
//  1. Stop accepting new HTTP connections (httpServer.close).
//  2. Drain all workers — worker.close() waits for the currently-running
//     concurrency slots to finish, up to SHUTDOWN_TIMEOUT_MS.
//  3. Exit cleanly.
//
// This lets in-flight AI replies and embedding jobs finish before the old
// container is replaced, eliminating silent message drops on every deploy.
// ---------------------------------------------------------------------------
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10);

async function shutdown(signal: string): Promise<void> {
  console.info(`[server] ${signal} received — starting graceful shutdown`, {
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  stopRedisMemoryMonitor();
  stopDeadLetterMonitor();
  stopLedgerRetention();

  // Stop the HTTP server from accepting new connections. Existing requests
  // will finish, then the server closes. The deploy health check stops polling
  // the old container once the new one is healthy, so this window is brief.
  httpServer.close();

  // Drain all BullMQ workers. worker.close() resolves once the current job(s)
  // for each worker complete (or the lock expires), whichever comes first.
  const workerDrains = [
    webhookWorker.close(),
    aiWorker.close(),
    notificationsWorker.close(),
    finetuningWorker.close(),
    defaultWorker.close(),
  ];

  // Race the drain against a hard timeout — if a job hangs, we still exit
  // cleanly rather than leaving a zombie container.
  const forceExit = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.warn('[server] Shutdown timeout reached — forcing exit');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS),
  );

  await Promise.race([Promise.allSettled(workerDrains), forceExit]);

  console.info('[server] Shutdown complete');
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
