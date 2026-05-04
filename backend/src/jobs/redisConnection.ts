/**
 * Shared non-blocking Redis for BullMQ Queues, cache, and rate limiting.
 * Workers use {@link createWorkerRedisConnection} from `./queue`.
 */
export { sharedConnection as redisConnection, createWorkerRedisConnection } from './queue';
