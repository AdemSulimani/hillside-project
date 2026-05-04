import type { DefaultJobOptions, QueueOptions } from 'bullmq';

/** Caps BullMQ event stream length in Redis (default is much larger). */
export const queueStreamsRedisOpts: Pick<QueueOptions, 'streams'> = {
  streams: {
    events: {
      maxLen: 100,
    },
  },
};

/** Default retention for completed/failed job records across queues. */
export const queueDefaultJobRetention: Pick<DefaultJobOptions, 'removeOnComplete' | 'removeOnFail'> = {
  removeOnComplete: 100,
  removeOnFail: 500,
};
