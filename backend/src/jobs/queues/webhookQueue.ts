import { Queue } from 'bullmq';
import { sharedConnection } from '../queue';
import type { InboundWebhookJobData } from '../jobTypes';
import { queueDefaultJobRetention, queueStreamsRedisOpts } from './queueRedisDefaults';

/** Inbound Meta / channel webhooks — fast, bounded retries. */
export const webhookQueue = new Queue<InboundWebhookJobData>('webhook', {
  connection: sharedConnection,
  ...queueStreamsRedisOpts,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'fixed', delay: 5000 },
    ...queueDefaultJobRetention,
  },
});
