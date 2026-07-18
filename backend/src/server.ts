import './bootstrap';
import './instrument';
import http from 'http';
import app from './app';
import { initSocketServer, closeSocketServer } from './sockets';
import { startRedisMemoryMonitor, stopRedisMemoryMonitor } from './services/redisMemoryMonitor';
import { recordConfigFingerprintBestEffort } from './jobs/configFingerprintRegistry';
import { initVectorCapabilityFromPool } from './db/vectorCapabilityProbe';
import { installCrossProcessSocketPublisher, closeCrossProcessSocketPublisher } from './services/socketPublisher';
import { resolveProcessRoleDetailed, roleRunsWorkers } from './config/processRole';
import { knobNumber } from './config/knobs';

/**
 * P2-7: the code default was 3000 while `.env.example`, docker-compose, BACKEND_URL, CI and
 * CLAUDE.md §10 all say 8000 — a documented-vs-code drift that only hid because every deployment
 * path happens to set PORT explicitly. Reconciled to 8000 (the documented value) and read through
 * the manifest so the two cannot diverge again.
 */
const PORT = knobNumber('PORT');

// P2-4 (F6): the retention sweep is deliberately NOT tied to AI_DECISION_LEDGER_ENABLED. Rows
// written during a flag-on period are customer-derived data with a GDPR retention obligation that
// does not end when recording stops — gating the sweep on the recording flag stranded them
// unpruned indefinitely. The sweep on an empty/absent-backlog table is one cheap indexed DELETE
// per tick, so running it unconditionally costs nothing when the ledger was never enabled.

/**
 * P3-2 Step 6: which halves of the process to start.
 *
 * Defaults to `'all'` — the pre-split topology, byte-for-byte — so every existing deployment is
 * unaffected until someone sets the variable. `'api'` is what makes an API-only replica possible.
 */
const roleResolution = resolveProcessRoleDetailed();
if (roleResolution.rejected !== null) {
  console.warn('[server] Unrecognised PROCESS_ROLE — using the default', {
    rejected: roleResolution.rejected,
    using: roleResolution.role,
  });
}
const PROCESS_ROLE = roleResolution.role;

const httpServer = http.createServer(app);
initSocketServer(httpServer);

/**
 * P3-2 Step 6: the workers are NOT statically imported any more.
 *
 * `jobs/workers.ts` constructs its five Workers as module-load side effects, so a static import
 * here would start the whole fleet regardless of role. (Note that removing this import alone was
 * never sufficient — `app.ts` reached the same module through `routes/health` until Step 5 cut that
 * edge, so `import app` by itself started every worker.)
 */
let closeWorkers: (() => Promise<void>) | null = null;

async function startWorkersIfNeeded(): Promise<void> {
  if (!roleRunsWorkers(PROCESS_ROLE)) {
    console.info('[server] PROCESS_ROLE=api — workers are NOT started in this process');
    return;
  }
  const workers = await import('./jobs/workers');
  closeWorkers = workers.closeAllWorkers;
}

httpServer.listen(PORT, () => {
  console.log(`[server] Running in ${process.env.NODE_ENV || 'development'} mode (role=${PROCESS_ROLE})`);
  console.log(`[server] Listening on http://localhost:${PORT}`);
  // Installed on the API too: the local `io` always wins in `emitTo`, so this changes nothing about
  // single-process delivery — it just means both roles run the same code path.
  installCrossProcessSocketPublisher();
  void startWorkersIfNeeded().catch((err: unknown) => {
    console.error('[server] Failed to start in-process workers', err);
  });
  // P3-2 Step 7: the dead-letter metrics and ledger-retention sweeps used to be `setInterval`s
  // here. Both do real work when they fire (bounded DELETEs, a Sentry burst alert), and an interval
  // runs once PER REPLICA — so they are now BullMQ schedulers, which `upsertJobScheduler` dedupes
  // by key. `redisMemoryMonitor` deliberately stays here: it only reads and logs, and a
  // Redis-scheduled job would go silent exactly when Redis is the thing failing.
  startRedisMemoryMonitor();
  // P3-2: probe pgvector's iterative-scan capability once. Best-effort — an unreachable database
  // here just leaves the adaptive-retry path in place.
  void initVectorCapabilityFromPool().catch(() => undefined);
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
//  1. Stop accepting new HTTP connections (httpServer.close) — and WAIT for it.
//  2. Close Socket.IO so clients are told to reconnect rather than hanging on a
//     dead socket until their own timeout.
//  3. Drain any in-process workers — worker.close() waits for the currently-running
//     concurrency slots to finish, up to SHUTDOWN_TIMEOUT_MS.
//  4. Exit cleanly.
//
// This lets in-flight AI replies and embedding jobs finish before the old
// container is replaced, eliminating silent message drops on every deploy.
// ---------------------------------------------------------------------------
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10);

async function shutdown(signal: string): Promise<void> {
  console.info(`[server] ${signal} received — starting graceful shutdown`, {
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    role: PROCESS_ROLE,
  });

  stopRedisMemoryMonitor();

  // P3-2: previously fire-and-forget. `httpServer.close()` only STOPS new connections; it resolves
  // when the last in-flight request finishes. Not awaiting it meant a request could still be
  // running when `process.exit(0)` fired below, which is a truncated response to a real client.
  const httpClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
  // Socket.IO was never closed at all, so connected clients kept a half-open socket to a dying
  // container until their own timeout instead of reconnecting to the new one.
  const socketsClosed = closeSocketServer();

  const forceExit = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.warn('[server] Shutdown timeout reached — forcing exit');
      resolve();
    }, SHUTDOWN_TIMEOUT_MS),
  );

  const drains: Array<Promise<unknown>> = [httpClosed, socketsClosed];
  if (closeWorkers) drains.push(closeWorkers());

  // Race the drain against a hard timeout — if a job hangs, we still exit
  // cleanly rather than leaving a zombie container.
  await Promise.race([Promise.allSettled(drains), forceExit]);

  await closeCrossProcessSocketPublisher();

  console.info('[server] Shutdown complete');
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
