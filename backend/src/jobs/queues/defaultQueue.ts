import { Queue } from 'bullmq';
import { sharedQueueConnection } from '../queue';
import type { GenerateProductEmbeddingJobData } from '../generateProductEmbedding';
import { redisOptimizedQueueBase } from './redisOptimizedQueueBase';

/** General background work (e.g. product embeddings). */
export const defaultQueue = new Queue<GenerateProductEmbeddingJobData>('default', {
  connection: sharedQueueConnection,
  ...redisOptimizedQueueBase,
  defaultJobOptions: {
    ...redisOptimizedQueueBase.defaultJobOptions,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
