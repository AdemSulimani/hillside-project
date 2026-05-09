import IORedis from 'ioredis';
import { Worker } from 'bullmq';
import type { WorkerOptions } from 'bullmq';
import { bullMqRedisConnectionOptions } from '../redisClientDefaults';
import { redisUrl } from './redisConnection';
import type { InboundWebhookJobData } from './jobTypes';
import { processInboundMessage } from './processInboundMessage';
import { processAIReply, type AIReplyJobData } from './processAIReply';
import { processGenerateProductEmbedding, type GenerateProductEmbeddingJobData } from './generateProductEmbedding';
import { initPrepareFinetuningScheduler, processPrepareFinetuning } from './prepareFinetuning';
import { initRefreshMetaTokensScheduler, processRefreshMetaTokens } from './refreshMetaTokens';
import { checkFinetuningStatus, startFinetuningJob } from './checkFinetuningStatus';
import { processNotificationJob } from './processNotificationJob';
import { attachWorkerFailureHandler } from './failureHandler';

/** Shared BullMQ worker tuning to reduce idle / polling Redis traffic. */
const redisOptimizedWorkerOptions: Pick<
  WorkerOptions,
  'stalledInterval' | 'maxStalledCount' | 'drainDelay' | 'lockDuration' | 'lockRenewTime' | 'settings'
> = {
  stalledInterval: 60_000,
  maxStalledCount: 2,
  drainDelay: 10,
  lockDuration: 30_000,
  lockRenewTime: 15_000,
  settings: {
    backoffStrategy: (attemptsMade) => Math.min(attemptsMade * 1000, 30_000),
  },
};

function createWorkerConnection(): IORedis {
  return new IORedis(redisUrl, bullMqRedisConnectionOptions);
}

/**
 * Allows operators to dial worker concurrency down on small hosts (e.g. the 1 vCPU droplet)
 * so that BullMQ jobs cannot starve the HTTP request loop. Defaults preserve historical
 * behaviour on hosts large enough to handle them.
 */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const WEBHOOK_CONCURRENCY = envInt('WEBHOOK_WORKER_CONCURRENCY', 10);
const AI_CONCURRENCY = envInt('AI_WORKER_CONCURRENCY', 5);
const NOTIFICATIONS_CONCURRENCY = envInt('NOTIFICATIONS_WORKER_CONCURRENCY', 3);
const FINETUNING_CONCURRENCY = envInt('FINETUNING_WORKER_CONCURRENCY', 1);
const DEFAULT_CONCURRENCY = envInt('DEFAULT_WORKER_CONCURRENCY', 3);

export const webhookWorker = new Worker<InboundWebhookJobData>(
  'webhook',
  async (job) => {
    await processInboundMessage(job.data);
  },
  { connection: createWorkerConnection(), concurrency: WEBHOOK_CONCURRENCY, ...redisOptimizedWorkerOptions },
);

export const aiWorker = new Worker<AIReplyJobData>(
  'ai',
  async (job) => {
    await processAIReply(job.data);
  },
  {
    connection: createWorkerConnection(),
    concurrency: AI_CONCURRENCY,
    ...redisOptimizedWorkerOptions,
  },
);

export const notificationsWorker = new Worker(
  'notifications',
  async (job) => {
    await processNotificationJob(job);
  },
  { connection: createWorkerConnection(), concurrency: NOTIFICATIONS_CONCURRENCY, ...redisOptimizedWorkerOptions },
);

export const finetuningWorker = new Worker(
  'finetuning',
  async (job) => {
    if (job.name === 'prepareFinetuning') {
      await processPrepareFinetuning();
      return;
    }
    if (job.name === 'startFinetuning') {
      await startFinetuningJob(job.data as { tenantId: string; filePath: string });
      return;
    }
    if (job.name === 'checkFinetuningStatus') {
      await checkFinetuningStatus(job.data as { tenantId: string; fineTuningJobId: string });
      return;
    }
    console.warn('[jobs] finetuning queue: unknown job name', { name: job.name, id: job.id });
  },
  {
    connection: createWorkerConnection(),
    concurrency: FINETUNING_CONCURRENCY,
    ...redisOptimizedWorkerOptions,
    stalledInterval: 300_000,
    lockDuration: 300_000,
  },
);

export const defaultWorker = new Worker<GenerateProductEmbeddingJobData>(
  'default',
  async (job) => {
    if (job.name === 'refreshMetaTokens') {
      await processRefreshMetaTokens();
      return;
    }
    await processGenerateProductEmbedding(job.data);
  },
  { connection: createWorkerConnection(), concurrency: DEFAULT_CONCURRENCY, ...redisOptimizedWorkerOptions },
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

void initRefreshMetaTokensScheduler().catch((err) => {
  console.error('[jobs] Failed to register Meta token refresh scheduler', err);
});
