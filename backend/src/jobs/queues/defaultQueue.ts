import { Queue } from 'bullmq';
import { redisConnection } from '../redisConnection';
import type { GenerateProductEmbeddingJobData } from '../generateProductEmbedding';

/** General background work (e.g. product embeddings). */
export const defaultQueue = new Queue<GenerateProductEmbeddingJobData>('default', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
