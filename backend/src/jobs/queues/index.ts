export { redisConnection } from '../redisConnection';
export { webhookQueue } from './webhookQueue';
export { aiQueue } from './aiQueue';
export { notificationsQueue } from './notificationsQueue';
export { finetuningQueue } from './finetuningQueue';
export { defaultQueue } from './defaultQueue';

import { webhookQueue } from './webhookQueue';
import { aiQueue } from './aiQueue';
import { notificationsQueue } from './notificationsQueue';
import { finetuningQueue } from './finetuningQueue';
import { defaultQueue } from './defaultQueue';

/**
 * P1-2: name → queue lookup for dead-letter replay. Re-enqueuing a stored payload needs the origin
 * queue by its `dead_letter.queue_name`. The queues carry different job-data generics, so the map is
 * typed to a minimal `add(name, data, opts?)` surface — the same escape hatch outboxRelay.ts uses
 * for the AI-typed queue.
 */
export interface AddableQueue {
  add(name: string, data: unknown, opts?: Record<string, unknown>): Promise<unknown>;
}

export const queueByName: Record<string, AddableQueue> = {
  webhook: webhookQueue as unknown as AddableQueue,
  ai: aiQueue as unknown as AddableQueue,
  notifications: notificationsQueue as unknown as AddableQueue,
  finetuning: finetuningQueue as unknown as AddableQueue,
  default: defaultQueue as unknown as AddableQueue,
};
