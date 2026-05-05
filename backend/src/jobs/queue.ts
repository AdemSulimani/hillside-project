import IORedis from 'ioredis';
import { redisClientDefaults } from '../redisClientDefaults';
import { redisUrl } from './redisConnection';

/**
 * Single shared Redis connection for all BullMQ Queue instances (non-blocking commands).
 * Workers must use separate connections — see `workers.ts`.
 */
export const sharedQueueConnection = new IORedis(redisUrl, redisClientDefaults);
