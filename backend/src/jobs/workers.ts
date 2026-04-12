import { Worker } from 'bullmq';
import { redisConnection } from './redisConnection';
import type { InboundWebhookJobData } from './jobTypes';
import { processInboundMessage } from './processInboundMessage';
import { processAIReply, type AIReplyJobData } from './processAIReply';
import { processGenerateProductEmbedding, type GenerateProductEmbeddingJobData } from './generateProductEmbedding';
import { initPrepareFinetuningScheduler, processPrepareFinetuning } from './prepareFinetuning';
import { processNotificationJob } from './processNotificationJob';
import { attachWorkerFailureHandler } from './failureHandler';

export const webhookWorker = new Worker<InboundWebhookJobData>(
  'webhook',
  async (job) => {
    await processInboundMessage(job.data);
  },
  { connection: redisConnection, concurrency: 10 },
);

export const aiWorker = new Worker<AIReplyJobData>(
  'ai',
  async (job) => {
    await processAIReply(job.data);
  },
  {
    connection: redisConnection,
    concurrency: 5,
    lockDuration: 60_000,
  },
);

export const notificationsWorker = new Worker(
  'notifications',
  async (job) => {
    await processNotificationJob(job);
  },
  { connection: redisConnection, concurrency: 3 },
);

export const finetuningWorker = new Worker(
  'finetuning',
  async (job) => {
    if (job.name === 'prepareFinetuning') {
      await processPrepareFinetuning();
      return;
    }
    console.warn('[jobs] finetuning queue: unknown job name', { name: job.name, id: job.id });
  },
  { connection: redisConnection, concurrency: 1, lockDuration: 300_000 },
);

export const defaultWorker = new Worker<GenerateProductEmbeddingJobData>(
  'default',
  async (job) => {
    await processGenerateProductEmbedding(job.data);
  },
  { connection: redisConnection, concurrency: 3 },
);

attachWorkerFailureHandler(webhookWorker, { queueName: 'webhook' });
attachWorkerFailureHandler(aiWorker, { queueName: 'ai' });
attachWorkerFailureHandler(notificationsWorker, { queueName: 'notifications', alertOnExhaustion: false });
attachWorkerFailureHandler(finetuningWorker, { queueName: 'finetuning' });
attachWorkerFailureHandler(defaultWorker, { queueName: 'default' });

aiWorker.on('completed', (job) => {
  console.info('[jobs] ai completed', { jobId: job?.id });
});

finetuningWorker.on('completed', (job) => {
  console.info('[jobs] finetuning completed', { jobId: job?.id, name: job?.name });
});

defaultWorker.on('completed', (job) => {
  console.info('[jobs] default (embedding) completed', { jobId: job?.id });
});

void initPrepareFinetuningScheduler().catch((err) => {
  console.error('[jobs] Failed to register finetuning scheduler', err);
});
