import type { RedisOptions } from 'ioredis';

/** Tuned ioredis options to limit redundant connection work and command retries. */
export const redisClientDefaults: RedisOptions = {
  maxRetriesPerRequest: 3,
  enableReadyCheck: false,
  lazyConnect: true,
  keepAlive: 10_000,
};

/**
 * BullMQ Workers issue blocking Redis commands; ioredis must not cap retries there
 * (see BullMQ connections guide). Queues on this client share the same requirement.
 */
export const bullMqRedisConnectionOptions: RedisOptions = {
  ...redisClientDefaults,
  maxRetriesPerRequest: null,
};
