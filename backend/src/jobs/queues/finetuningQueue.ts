import { Queue } from 'bullmq';
import { redisConnection } from '../redisConnection';

/** Nightly fine-tuning dataset preparation — long-running, no retries. */
export const finetuningQueue = new Queue<Record<string, never>, unknown, string>('finetuning', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 50 },
  },
});
