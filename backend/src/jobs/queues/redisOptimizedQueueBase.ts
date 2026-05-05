import type { QueueOptions } from 'bullmq';

/** Shared Queue tuning: trim completed/failed job keys and cap event stream length in Redis. */
export const redisOptimizedQueueBase: Pick<QueueOptions, 'streams'> & {
  defaultJobOptions: Pick<
    NonNullable<QueueOptions['defaultJobOptions']>,
    'removeOnComplete' | 'removeOnFail'
  >;
} = {
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  streams: {
    events: {
      maxLen: 100,
    },
  },
};
