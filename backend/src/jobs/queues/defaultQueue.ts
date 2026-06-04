import { Queue } from 'bullmq';
import { sharedQueueConnection } from '../queue';
import type { GenerateProductEmbeddingJobData } from '../generateProductEmbedding';
import type { GenerateProductImageFingerprintJobData } from '../generateProductImageFingerprint';
import { redisOptimizedQueueBase } from './redisOptimizedQueueBase';

export type DefaultQueueJobData =
  | GenerateProductEmbeddingJobData
  | GenerateProductImageFingerprintJobData
  | Record<string, never>;

/** General background work (e.g. product embeddings, image fingerprints). */
export const defaultQueue = new Queue<DefaultQueueJobData>('default', {
  connection: sharedQueueConnection,
  ...redisOptimizedQueueBase,
  defaultJobOptions: {
    ...redisOptimizedQueueBase.defaultJobOptions,
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  },
});
