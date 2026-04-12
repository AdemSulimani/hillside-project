import type { Queue } from 'bullmq';
import type { Worker } from 'bullmq';
import {
  webhookQueue,
  aiQueue,
  notificationsQueue,
  finetuningQueue,
  defaultQueue,
} from '../jobs/queues';
import {
  webhookWorker,
  aiWorker,
  notificationsWorker,
  finetuningWorker,
  defaultWorker,
} from '../jobs/workers';

export interface QueueCountsSnapshot {
  waiting: number;
  active: number;
  delayed: number;
  paused: number;
  completed: number;
  failed: number;
}

export interface WorkerStatusSnapshot {
  concurrency: number;
  isRunning: boolean;
  isPaused: boolean;
  /** Workers registered in Redis for this queue (any host). */
  redisWorkersCount: number;
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

function parseDepthThreshold(): number {
  const raw = process.env.QUEUE_HEALTH_DEPTH_WARNING;
  if (raw === undefined || raw === '') return 100;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 100;
}

function normalizeCounts(raw: Record<string, number>): QueueCountsSnapshot {
  return {
    waiting: raw.waiting ?? 0,
    active: raw.active ?? 0,
    delayed: raw.delayed ?? 0,
    paused: raw.paused ?? 0,
    completed: raw.completed ?? 0,
    failed: raw.failed ?? 0,
  };
}

function evaluateQueue(
  key: string,
  label: string,
  queue: Queue,
  worker: Worker,
  counts: QueueCountsSnapshot,
  depthThreshold: number,
  redisWorkersCount: number,
): SingleQueueHealth {
  const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0);
  const workerSnap: WorkerStatusSnapshot = {
    concurrency: worker.opts.concurrency ?? 1,
    isRunning: worker.isRunning(),
    isPaused: worker.isPaused(),
    redisWorkersCount,
  };

  const issues: string[] = [];
  if (depth > depthThreshold) {
    issues.push(`depth ${depth} exceeds threshold ${depthThreshold}`);
  }
  if (!workerSnap.isRunning) {
    issues.push('worker not running');
  }
  if (workerSnap.isPaused) {
    issues.push('worker paused');
  }

  const healthy = issues.length === 0;

  return {
    key,
    label,
    counts,
    depth,
    worker: workerSnap,
    healthy,
    issues,
  };
}

const registry: ReadonlyArray<{
  key: string;
  label: string;
  queue: Queue;
  worker: Worker;
}> = [
  { key: 'webhook', label: 'Webhook / inbound', queue: webhookQueue, worker: webhookWorker },
  { key: 'ai', label: 'AI replies', queue: aiQueue, worker: aiWorker },
  { key: 'notifications', label: 'Notifications', queue: notificationsQueue, worker: notificationsWorker },
  { key: 'finetuning', label: 'Fine-tuning', queue: finetuningQueue, worker: finetuningWorker },
  { key: 'default', label: 'Default (embeddings)', queue: defaultQueue, worker: defaultWorker },
];

export async function getQueuesHealth(): Promise<QueuesHealthPayload> {
  const depthWarningThreshold = parseDepthThreshold();

  const queues: SingleQueueHealth[] = [];

  for (const { key, label, queue, worker } of registry) {
    const [rawCounts, redisWorkersCount] = await Promise.all([
      queue.getJobCounts() as Promise<Record<string, number>>,
      queue.getWorkersCount(),
    ]);
    const counts = normalizeCounts(rawCounts);
    queues.push(evaluateQueue(key, label, queue, worker, counts, depthWarningThreshold, redisWorkersCount));
  }

  const overallHealthy = queues.every((q) => q.healthy);
  const overallDegraded = !overallHealthy;

  return {
    queues,
    depthWarningThreshold,
    overallHealthy,
    overallDegraded,
  };
}
