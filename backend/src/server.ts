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

const PORT = parseInt(process.env.PORT || '3000', 10);

/** P1-2 step 5: dead-letter growth monitor (off by default). */
const DLQ_METRICS_ENABLED = (process.env.DLQ_METRICS_ENABLED ?? 'false').trim().toLowerCase() === 'true';

/**
 * P2-4 Part 2: ledger retention sweep. Tied to the ledger's OWN flag, not a metrics flag — if the
 * ledger is recording, its rows must also expire. Off by default, exactly like the ledger itself,
 * so this is inert until someone turns recording on (nothing to prune before then anyway).
 */
const AI_DECISION_LEDGER_ENABLED =
  (process.env.AI_DECISION_LEDGER_ENABLED ?? 'false').trim().toLowerCase() === 'true';

const httpServer = http.createServer(app);
initSocketServer(httpServer);

httpServer.listen(PORT, () => {
  console.log(`[server] Running in ${process.env.NODE_ENV || 'development'} mode`);
  console.log(`[server] Listening on http://localhost:${PORT}`);
  startRedisMemoryMonitor();
  if (DLQ_METRICS_ENABLED) startDeadLetterMonitor();
  if (AI_DECISION_LEDGER_ENABLED) startLedgerRetention();
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
