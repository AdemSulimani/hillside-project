import { Queue } from 'bullmq';
import { sharedQueueConnection } from '../queue';
import { redisOptimizedQueueBase } from './redisOptimizedQueueBase';

export type NotificationJobData = Record<string, unknown>;

/** Email / push / internal notifications (reserved for future jobs). */
export const notificationsQueue = new Queue<NotificationJobData>('notifications', {
  connection: sharedQueueConnection,
  ...redisOptimizedQueueBase,
  defaultJobOptions: {
    ...redisOptimizedQueueBase.defaultJobOptions,
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
  },
});
