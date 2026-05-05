import IORedis from 'ioredis';
import { redisClientDefaults } from '../redisClientDefaults';

export const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/** General-purpose Redis (cache, rate limits, dedupe). BullMQ uses `queue.ts` + per-worker clients. */
export const redisConnection = new IORedis(redisUrl, redisClientDefaults);
