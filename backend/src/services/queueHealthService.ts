/**
 * P3-2 Step 5: this module NO LONGER imports `jobs/workers`.
 *
 * That import existed only to read three local Worker facts, but the five `new Worker(...)` calls
 * there are module-load side effects — so it made the entire worker fleet a transitive dependency
 * of `app.ts` via `routes/health` → `healthController`. Local facts now arrive through
 * `localWorkerRegistry`, which the worker side writes; the scoring lives in `queueHealthCore`.
 *
 * Queues are still imported directly and that is correct: a `Queue` is a client handle, not a
 * consumer. Constructing one starts nothing.
 */
import {
  webhookQueue,
  aiQueue,
  notificationsQueue,
  finetuningQueue,
  defaultQueue,
} from '../jobs/queues';
import { readLocalWorker } from './localWorkerRegistry';
import {
  evaluateQueueHealth,
  normalizeCounts,
  parseDepthThreshold,
  summarize,
  type QueuesHealthPayload,
  type SingleQueueHealth,
} from './queueHealthCore';

export type {
  QueueCountsSnapshot,
  WorkerStatusSnapshot,
  SingleQueueHealth,
  QueuesHealthPayload,
} from './queueHealthCore';

const registry = [
  { key: 'webhook', label: 'Webhook / inbound', queue: webhookQueue },
  { key: 'ai', label: 'AI replies', queue: aiQueue },
  { key: 'notifications', label: 'Notifications', queue: notificationsQueue },
  { key: 'finetuning', label: 'Fine-tuning', queue: finetuningQueue },
  { key: 'default', label: 'Default (embeddings)', queue: defaultQueue },
] as const;

export async function getQueuesHealth(): Promise<QueuesHealthPayload> {
  const depthWarningThreshold = parseDepthThreshold(process.env.QUEUE_HEALTH_DEPTH_WARNING);

  const queues: SingleQueueHealth[] = [];

  for (const { key, label, queue } of registry) {
    const [rawCounts, redisWorkersCount] = await Promise.all([
      queue.getJobCounts() as Promise<Record<string, number>>,
      queue.getWorkersCount(),
    ]);
    queues.push(
      evaluateQueueHealth({
        key,
        label,
        counts: normalizeCounts(rawCounts),
        depthThreshold: depthWarningThreshold,
        redisWorkersCount,
        local: readLocalWorker(key),
      }),
    );
  }

  return summarize(queues, depthWarningThreshold);
}
