/**
 * P3-2 Step 5 — the pure scoring half of queue health.
 *
 * Extracted so it can be tested with no BullMQ, no Redis and no live Worker, and so
 * `queueHealthService` shrinks to "fetch counts, call this". The interesting change is that
 * worker liveness now has TWO sources, and which one applies depends on the process topology:
 *
 *   - `local` — the Worker object in THIS process. Authoritative when present, and the only source
 *     that can report concurrency or a manual pause.
 *   - `redisWorkersCount` — workers registered in Redis for the queue, from ANY host. The only
 *     source available to an API-only process, and the *more* correct one in a split fleet: it
 *     answers "is anything consuming this queue", which is what the health endpoint is actually for.
 *
 * Before the split these always agreed, so the distinction did not exist. After it, an API replica
 * reporting `isRunning: false` because it holds no Worker would be a false alarm on every request.
 */
import type { LocalWorkerSnapshot } from './localWorkerRegistry';

export interface QueueCountsSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  paused: number;
  completed: number;
  failed: number;
}

export interface WorkerStatusSnapshot {
  /** Concurrency of the in-process Worker, or `null` when this process does not run it. */
  concurrency: number | null;
  isRunning: boolean;
  isPaused: boolean;
  /** Workers registered in Redis for this queue (any host). */
  redisWorkersCount: number;
  /** Whether the Worker for this queue lives in the process serving this request. */
  inProcess: boolean;
}

export interface SingleQueueHealth {
  key: string;
  label: string;
  counts: QueueCountsSnapshot;
  /** Jobs not yet active (backlog indicator). */
  depth: number;
  worker: WorkerStatusSnapshot;
  healthy: boolean;
  issues: string[];
}

export interface QueuesHealthPayload {
  queues: SingleQueueHealth[];
  depthWarningThreshold: number;
  overallHealthy: boolean;
  overallDegraded: boolean;
}

export const DEFAULT_DEPTH_WARNING = 100;

/** Tolerant by design: a malformed threshold must not fail the health endpoint. */
export function parseDepthThreshold(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_DEPTH_WARNING;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DEPTH_WARNING;
}

export function normalizeCounts(raw: Record<string, number>): QueueCountsSnapshot {
  return {
    waiting: raw.waiting ?? 0,
    active: raw.active ?? 0,
    delayed: raw.delayed ?? 0,
    paused: raw.paused ?? 0,
    completed: raw.completed ?? 0,
    failed: raw.failed ?? 0,
  };
}

export interface EvaluateQueueInput {
  key: string;
  label: string;
  counts: QueueCountsSnapshot;
  depthThreshold: number;
  redisWorkersCount: number;
  /** `null` when this process does not run the Worker for this queue. */
  local: LocalWorkerSnapshot | null;
}

export function evaluateQueueHealth(input: EvaluateQueueInput): SingleQueueHealth {
  const { key, label, counts, depthThreshold, redisWorkersCount, local } = input;
  const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0);

  const worker: WorkerStatusSnapshot = {
    concurrency: local ? local.concurrency : null,
    // Local truth wins when we have it; otherwise fall back to "someone, somewhere is consuming
    // this queue". An API-only process has no Worker and must not report the queue as dead.
    isRunning: local ? local.isRunning : redisWorkersCount > 0,
    // A pause is a per-Worker action and is not observable through the Redis registration count,
    // so an API-only process reports false rather than guessing.
    isPaused: local ? local.isPaused : false,
    redisWorkersCount,
    inProcess: local !== null,
  };

  const issues: string[] = [];
  if (depth > depthThreshold) {
    issues.push(`depth ${depth} exceeds threshold ${depthThreshold}`);
  }
  if (!worker.isRunning) {
    issues.push(local ? 'worker not running' : 'no workers registered for this queue');
  }
  if (worker.isPaused) {
    issues.push('worker paused');
  }

  return { key, label, counts, depth, worker, healthy: issues.length === 0, issues };
}

export function summarize(
  queues: SingleQueueHealth[],
  depthWarningThreshold: number,
): QueuesHealthPayload {
  const overallHealthy = queues.every((q) => q.healthy);
  return {
    queues,
    depthWarningThreshold,
    overallHealthy,
    overallDegraded: !overallHealthy,
  };
}
