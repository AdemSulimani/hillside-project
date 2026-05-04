import { Queue } from 'bullmq';
import { sharedConnection } from '../queue';
import type { AIReplyJobData } from '../processAIReply';
import { queueDefaultJobRetention, queueStreamsRedisOpts } from './queueRedisDefaults';

/** AI reply generation — moderate concurrency, bounded runtime per job. */
export const aiQueue = new Queue<AIReplyJobData, unknown, string>('ai', {
  connection: sharedConnection,
  ...queueStreamsRedisOpts,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
    ...queueDefaultJobRetention,
  },
});
