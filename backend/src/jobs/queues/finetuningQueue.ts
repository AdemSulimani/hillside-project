import { Queue } from 'bullmq';
import { sharedQueueConnection } from '../queue';
import { redisOptimizedQueueBase } from './redisOptimizedQueueBase';

/** Nightly fine-tuning dataset preparation and polling jobs. */
export const finetuningQueue = new Queue<Record<string, unknown>, unknown, string>('finetuning', {
  connection: sharedQueueConnection,
  ...redisOptimizedQueueBase,
  defaultJobOptions: {
    ...redisOptimizedQueueBase.defaultJobOptions,
    attempts: 1,
  },
});
