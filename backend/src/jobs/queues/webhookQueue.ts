import { Queue } from 'bullmq';
import { redisConnection } from '../redisConnection';
import type { InboundWebhookJobData } from '../jobTypes';

/** Inbound Meta / channel webhooks — fast, bounded retries. */
export const webhookQueue = new Queue<InboundWebhookJobData>('webhook', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
});
