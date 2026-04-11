import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import type { InboundWebhookJobData } from './processInboundMessage';

export const redisConnection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  maxRetriesPerRequest: null,
});

export const inboundMessageQueue = new Queue<InboundWebhookJobData>('message.inbound', {
  connection: redisConnection,
});

export const aiQueue = new Queue('ai.reply', {
  connection: redisConnection,
});

export const prepareFinetuningQueue = new Queue<Record<string, never>>('finetuning.prepare', {
  connection: redisConnection,
});
