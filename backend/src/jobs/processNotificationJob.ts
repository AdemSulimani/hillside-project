import type { Job } from 'bullmq';
import type { NotificationJobData } from './queues/notificationsQueue';
import { postOpsJobFailedAlert } from './opsAlert';

/**
 * P1-2: processor for the (previously dead, zero-producer) `notifications` queue.
 *
 * The queue is now a real transport for operator notifications. Its first producer is the failure
 * handler, which enqueues `ops.jobFailed` when a job is dead-lettered — delivering the operator
 * webhook with BullMQ's durable retry (attempts:5) instead of a fire-and-forget axios call. A throw
 * here is intentional: it lets BullMQ retry, and the `queueName !== 'notifications'` producer guard
 * prevents a failed notification from enqueuing another one (no feedback loop).
 */
export async function processNotificationJob(job: Job<NotificationJobData>): Promise<void> {
  if (job.name === 'ops.jobFailed') {
    const data = job.data as {
      queue?: string;
      jobId?: string | null;
      jobName?: string | null;
      classification?: string | null;
      error?: string | null;
      stack?: string | null;
    };
    console.error('[notifications] queue job dead-lettered', {
      queue: data.queue,
      jobId: data.jobId,
      jobName: data.jobName,
      classification: data.classification,
      error: data.error,
    });
    await postOpsJobFailedAlert({
      queueName: data.queue ?? 'unknown',
      jobId: data.jobId,
      jobName: data.jobName,
      classification: data.classification,
      message: data.error ?? 'unknown error',
      stack: data.stack,
    });
    return;
  }

  console.warn('[notifications] unknown notification job (no-op)', {
    jobId: job.id,
    name: job.name,
  });
}
