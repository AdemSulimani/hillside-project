import type { Job } from 'bullmq';
import type { NotificationJobData } from './queues/notificationsQueue';

/**
 * Placeholder processor for the notifications queue until real channels are wired.
 */
export async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  console.info('[jobs] notifications job received (no-op)', {
    jobId: job.id,
    name: job.name,
  });
}
