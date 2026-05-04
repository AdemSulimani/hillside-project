import { Queue } from 'bullmq';
import { sharedConnection } from '../queue';
import type { GenerateProductEmbeddingJobData } from '../generateProductEmbedding';
import { queueDefaultJobRetention, queueStreamsRedisOpts } from './queueRedisDefaults';

/** General background work (e.g. product embeddings). */
export const defaultQueue = new Queue<GenerateProductEmbeddingJobData>('default', {
  connection: sharedConnection,
  ...queueStreamsRedisOpts,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    ...queueDefaultJobRetention,
  },
});
