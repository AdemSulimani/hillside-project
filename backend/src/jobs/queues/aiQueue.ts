import { Queue } from 'bullmq';
import { redisConnection } from '../redisConnection';
import type { AIReplyJobData } from '../processAIReply';

/** AI reply generation — moderate concurrency, bounded runtime per job. */
export const aiQueue = new Queue<AIReplyJobData, unknown, string>('ai', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  },
});
