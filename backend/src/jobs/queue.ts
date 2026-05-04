import IORedis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

/** Options reused by the shared queue client and each worker client. */
const redisConfig = {
  /**
   * Required for BullMQ: finite values break blocking subscribers when using a
   * pre-instantiated ioredis client (see BullMQ RedisConnection).
   */
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  lazyConnect: true,
  keepAlive: 10_000,
};

/** One connection for every BullMQ Queue and other non-blocking app Redis use. */
export const sharedConnection = new IORedis(redisUrl, redisConfig);

/**
 * Each BullMQ Worker performs blocking Redis calls and must use its own ioredis instance.
 */
export function createWorkerRedisConnection(): IORedis {
  return new IORedis(redisUrl, redisConfig);
}
