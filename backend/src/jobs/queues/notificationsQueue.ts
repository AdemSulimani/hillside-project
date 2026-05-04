import { Queue } from 'bullmq';
import { redisConnection } from '../redisConnection';

export type NotificationJobData = Record<string, unknown>;

/** Email / push / internal notifications (reserved for future jobs). */
export const notificationsQueue = new Queue<NotificationJobData>('notifications', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 200,
    removeOnFail: 200,
  },
});
