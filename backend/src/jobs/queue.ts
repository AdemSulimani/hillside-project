import { Worker } from 'bullmq';
import { processInboundMessage, type InboundWebhookJobData } from './processInboundMessage';
import { redisConnection } from './queues';

export const inboundMessageWorker = new Worker<InboundWebhookJobData>(
  'message.inbound',
  async (job) => {
    await processInboundMessage(job.data);
  },
  { connection: redisConnection },
);

inboundMessageWorker.on('failed', (job, err) => {
  console.error('[jobs] message.inbound failed', {
    jobId: job?.id,
    name: job?.name,
    error: err.message,
  });
});
