import { Worker } from 'bullmq';
import { processInboundMessage, type InboundWebhookJobData } from './processInboundMessage';
import { processAIReply, type AIReplyJobData } from './processAIReply';
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

export const aiReplyWorker = new Worker<AIReplyJobData>(
  'ai.reply',
  async (job) => {
    await processAIReply(job.data);
  },
  {
    connection: redisConnection,
    concurrency: 3,
  },
);

aiReplyWorker.on('failed', (job, err) => {
  console.error('[jobs] ai.reply failed', {
    jobId: job?.id,
    name: job?.name,
    error: err.message,
  });
});

aiReplyWorker.on('completed', (job) => {
  console.info('[jobs] ai.reply completed', { jobId: job?.id });
});
