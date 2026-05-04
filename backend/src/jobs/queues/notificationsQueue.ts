import { Queue } from 'bullmq';
import { sharedConnection } from '../queue';
import { queueDefaultJobRetention, queueStreamsRedisOpts } from './queueRedisDefaults';

export type NotificationJobData = Record<string, unknown>;

/** Email / push / internal notifications (reserved for future jobs). */
export const notificationsQueue = new Queue<NotificationJobData>('notifications', {
  connection: sharedConnection,
  ...queueStreamsRedisOpts,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    ...queueDefaultJobRetention,
  },
});
