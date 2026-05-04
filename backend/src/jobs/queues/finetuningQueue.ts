import { Queue } from 'bullmq';
import { sharedConnection } from '../queue';
import { queueDefaultJobRetention, queueStreamsRedisOpts } from './queueRedisDefaults';

/** Nightly fine-tuning dataset preparation and polling jobs. */
export const finetuningQueue = new Queue<Record<string, unknown>, unknown, string>('finetuning', {
  connection: sharedConnection,
  ...queueStreamsRedisOpts,
  defaultJobOptions: {
    attempts: 1,
    ...queueDefaultJobRetention,
  },
});
