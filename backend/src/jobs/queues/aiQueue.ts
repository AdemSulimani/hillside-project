import { Queue } from 'bullmq';
import { sharedQueueConnection } from '../queue';
import type { AIReplyJobData } from '../processAIReply';
import { redisOptimizedQueueBase } from './redisOptimizedQueueBase';

/** AI reply generation — moderate concurrency, bounded runtime per job. */
export const aiQueue = new Queue<AIReplyJobData, unknown, string>('ai', {
  connection: sharedQueueConnection,
  ...redisOptimizedQueueBase,
  defaultJobOptions: {
    ...redisOptimizedQueueBase.defaultJobOptions,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  },
});
