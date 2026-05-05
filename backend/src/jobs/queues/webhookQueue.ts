import { Queue } from 'bullmq';
import { sharedQueueConnection } from '../queue';
import type { InboundWebhookJobData } from '../jobTypes';
import { redisOptimizedQueueBase } from './redisOptimizedQueueBase';

/** Inbound Meta / channel webhooks — fast, bounded retries. */
export const webhookQueue = new Queue<InboundWebhookJobData>('webhook', {
  connection: sharedQueueConnection,
  ...redisOptimizedQueueBase,
  defaultJobOptions: {
    ...redisOptimizedQueueBase.defaultJobOptions,
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
  },
});
