/**
 * Shared Redis clients for the integration suite (`npm run test:integration`).
 *
 * These tests are NOT part of the offline `npm test` suite: they require a reachable
 * Redis (default `redis://127.0.0.1:6379`, override with REDIS_URL) and fail fast with
 * a clear error when it is absent. They never touch the app's shared `redisConnection`,
 * so the test process always exits cleanly.
 */
import IORedis from 'ioredis';

export function createRedisTestClient(): IORedis {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  return new IORedis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: () => null,
  });
}

/**
 * A client pointed at a dead port, for exercising real error paths (not stubs): commands
 * reject immediately (`enableOfflineQueue: false`) and it never reconnects.
 */
export function createBrokenRedisClient(): IORedis {
  return new IORedis('redis://127.0.0.1:1', {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 300,
    retryStrategy: () => null,
  });
}
