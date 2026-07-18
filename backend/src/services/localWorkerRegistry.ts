/**
 * P3-2 Step 5 — inverts the API → `jobs/workers` dependency.
 *
 * `queueHealthService` used to `import { aiWorker, … } from '../jobs/workers'` just to read three
 * local facts (concurrency, isRunning, isPaused). Because those five `new Worker(...)` calls are
 * module-load SIDE EFFECTS, that import made the whole worker fleet a transitive dependency of the
 * Express app:
 *
 *     app.ts → routes/health.ts → controllers/healthController.ts → services/queueHealthService.ts
 *            → jobs/workers.ts  ⇒ five Workers constructed
 *
 * So `import app` alone started every worker, and deleting `server.ts`'s import would have done
 * nothing at all. That edge is the hard prerequisite for an API-only process.
 *
 * The fix is a registry the worker side WRITES and the health side READS. Nothing here imports
 * BullMQ or Redis, so it costs the API process nothing; in an API-only process the registry is
 * simply empty, which is the honest answer to "are workers running in *this* process".
 *
 * `services/__tests__/fleetTopologyIsolation.test.ts` pins the resulting import graph.
 */

/** The three facts that are only knowable inside the process that owns the Worker. */
export interface LocalWorkerSnapshot {
  concurrency: number;
  isRunning: boolean;
  isPaused: boolean;
}

/**
 * Read lazily rather than stored as a value: `isRunning`/`isPaused` change over a process's
 * lifetime (drain on shutdown, manual pause), so a snapshot captured at registration would go
 * stale immediately.
 */
type SnapshotReader = () => LocalWorkerSnapshot;

const readers = new Map<string, SnapshotReader>();

/** Called once per Worker, from the process that constructs it. */
export function registerLocalWorker(queueKey: string, read: SnapshotReader): void {
  readers.set(queueKey, read);
}

/**
 * The live snapshot for a queue's worker in THIS process, or `null` when this process does not run
 * it. `null` is not an error — it is the expected answer in an API-only process.
 */
export function readLocalWorker(queueKey: string): LocalWorkerSnapshot | null {
  const read = readers.get(queueKey);
  if (!read) return null;
  try {
    return read();
  } catch {
    // A Worker torn down mid-shutdown can throw on these accessors. Report "not local" rather than
    // failing a health check that exists precisely to be readable during a bad moment.
    return null;
  }
}

/** Whether this process runs any workers at all. */
export function hasLocalWorkers(): boolean {
  return readers.size > 0;
}

/** Test-only: drop all registrations. */
export function resetLocalWorkerRegistryForTests(): void {
  readers.clear();
}
