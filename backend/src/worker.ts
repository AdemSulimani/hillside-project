/**
 * P3-2 Step 6 — the worker entrypoint.
 *
 * Runs the five BullMQ workers and the nine schedulers WITHOUT Express or Socket.IO, so the worker
 * fleet becomes its own deploy unit and its own failure domain: a worker crash-loop no longer takes
 * the API down, and worker replicas scale independently of the HTTP tier.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 *  1. The socket publisher is installed BEFORE `jobs/workers` is imported, and its absence is
 *     FATAL. Those five `new Worker(...)` calls are module-load side effects that can start
 *     consuming immediately, so a job that emits must never observe a process with no transport.
 *     A worker with no `io` and no publisher drops every emit; the merchant-visible symptom is a
 *     frozen inbox while the AI replies normally — silent, and near-impossible to diagnose from
 *     the outside. That is worth refusing to start for.
 *  2. `recordConfigFingerprintBestEffort()` is called here too. It used to live only in
 *     `server.ts`'s `listen` callback — a worker has no listener, so it would never publish a row
 *     and `countDistinctLiveFingerprints()` would keep answering 1 while the fleet genuinely
 *     drifted. The drift check is only as good as its least-reporting member.
 *  3. Shutdown drains workers, THEN releases Redis and the pool. `WORKER_SHUTDOWN_TIMEOUT_MS`
 *     defaults higher than the API's 25s because one `ai.reply` turn is a ~25-call OpenAI fan-out,
 *     and the container's `stop_grace_period` must exceed it — inverting them means Docker
 *     SIGKILLs mid-drain, the C-88 defect the API side already fixed.
 */
import './bootstrap';
import './instrument';
import http from 'http';
import pool from './db/pool';
import { redisConnection } from './jobs/redisConnection';
import { resolveProcessRole, resolveProcessRoleDetailed } from './config/processRole';
import { knobBool } from './config/knobs';
import {
  installCrossProcessSocketPublisher,
  closeCrossProcessSocketPublisher,
} from './services/socketPublisher';
import { recordConfigFingerprintBestEffort } from './jobs/configFingerprintRegistry';
import { initVectorCapabilityFromPool } from './db/vectorCapabilityProbe';
import { getQueuesHealth } from './services/queueHealthService';

/**
 * A dedicated port so Compose and Render both have something to probe. A background worker with no
 * listener cannot be health-checked, and `scripts/deploy.sh` polls `backend` by name only — a
 * crash-looping worker would otherwise deploy green.
 */
const WORKER_HEALTH_PORT = parseInt(process.env.WORKER_HEALTH_PORT || '8001', 10);
const WORKER_SHUTDOWN_TIMEOUT_MS = parseInt(process.env.WORKER_SHUTDOWN_TIMEOUT_MS || '35000', 10);

let closeWorkers: (() => Promise<void>) | null = null;
let healthServer: http.Server | null = null;
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[worker] ${signal} received — starting graceful shutdown`, {
    timeoutMs: WORKER_SHUTDOWN_TIMEOUT_MS,
  });

  healthServer?.close();

  const forceExit = new Promise<void>((resolve) =>
    setTimeout(() => {
      console.warn('[worker] Shutdown timeout reached — forcing exit');
      resolve();
    }, WORKER_SHUTDOWN_TIMEOUT_MS),
  );

  // Drain first: `worker.close()` waits for in-flight jobs, and those jobs still need Redis and the
  // pool. Releasing either before the drain would fail the very jobs we are trying to finish.
  if (closeWorkers) {
    await Promise.race([closeWorkers(), forceExit]);
  }

  await closeCrossProcessSocketPublisher();
  await redisConnection.quit().catch(() => undefined);
  await pool.end().catch(() => undefined);

  console.info('[worker] Shutdown complete');
  process.exit(0);
}

async function main(): Promise<void> {
  const roleResolution = resolveProcessRoleDetailed();
  if (roleResolution.rejected !== null) {
    console.warn('[worker] Unrecognised PROCESS_ROLE — using the default', {
      rejected: roleResolution.rejected,
    });
  }

  if (!knobBool('SOCKET_CROSS_PROCESS_EMIT')) {
    console.error(
      '[worker] REFUSING TO START: SOCKET_CROSS_PROCESS_EMIT is not enabled.\n' +
        '  A worker process has no local Socket.IO server, so every real-time event it produces\n' +
        '  (new_message, conversation_updated, ai_alert, …) would be dropped.\n' +
        '  The inbox has no polling fallback, so merchants would see a frozen thread while the AI\n' +
        '  replies normally — silent, and near-impossible to diagnose from the outside.\n' +
        '  Set SOCKET_CROSS_PROCESS_EMIT=true on BOTH the API and the worker, or run PROCESS_ROLE=all.',
    );
    process.exit(1);
  }

  const publisher = installCrossProcessSocketPublisher();
  if (!publisher.installed) {
    console.error('[worker] REFUSING TO START: socket publisher failed to install', publisher);
    process.exit(1);
  }

  // Imported only now — see (1) in the module docs.
  const workers = await import('./jobs/workers');
  closeWorkers = workers.closeAllWorkers;

  // Best-effort and deliberately not awaited: the capability must be probed rather than inferred
  // (see db/vectorCapability.ts), but retrieval works fine without it.
  void initVectorCapabilityFromPool().catch(() => undefined);

  healthServer = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      void getQueuesHealth()
        .then((payload) => {
          res.writeHead(payload.overallHealthy ? 200 : 503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, role: resolveProcessRole(), data: payload }));
        })
        .catch((err: unknown) => {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              success: false,
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Not found' }));
  });

  healthServer.listen(WORKER_HEALTH_PORT, () => {
    console.log(`[worker] Running in ${process.env.NODE_ENV || 'development'} mode`);
    console.log(`[worker] Health endpoint on http://localhost:${WORKER_HEALTH_PORT}/health`);
    void recordConfigFingerprintBestEffort();
  });

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err: unknown) => {
  console.error('[worker] Fatal error during startup', err);
  process.exit(1);
});
