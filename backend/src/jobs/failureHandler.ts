import type { Job, Worker } from 'bullmq';
import axios from 'axios';

export interface WorkerFailureHandlerOptions {
  /** Logical queue name for logs and alerts. */
  queueName: string;
  /** When false, exhausted failures are only logged (no external alert). */
  alertOnExhaustion?: boolean;
}

function maxAttemptsForJob(job: Job): number {
  const n = job.opts.attempts;
  return typeof n === 'number' && n >= 1 ? n : 1;
}

function isPermanentlyFailed(job: Job | undefined): boolean {
  if (!job) return false;
  return job.attemptsMade >= maxAttemptsForJob(job);
}

async function sendProductionAlert(payload: {
  queueName: string;
  jobId: string | undefined;
  jobName: string | undefined;
  message: string;
  stack?: string;
}): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) {
    console.warn('[jobs] ALERT_WEBHOOK_URL is not set; cannot send production alert');
    return;
  }

  const text = [
    `*Queue job permanently failed*`,
    `Queue: \`${payload.queueName}\``,
    `Job: \`${payload.jobName ?? 'unknown'}\` (\`${payload.jobId ?? 'unknown'}\`)`,
    `Error: ${payload.message}`,
    payload.stack ? `\`\`\`${payload.stack.slice(0, 3500)}\`\`\`` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const resp = await axios.post(url, { text }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000,
      validateStatus: () => true,
    });
    if (resp.status < 200 || resp.status >= 300) {
      console.error('[jobs] Alert webhook returned non-success status', {
        status: resp.status,
        data: resp.data,
      });
    }
  } catch (err) {
    console.error('[jobs] Failed to POST ALERT_WEBHOOK_URL', {
      error: err instanceof Error ? err.message : err,
    });
  }
}

/**
 * Fires when a job has used all configured attempts. Logs in all environments;
 * posts to ALERT_WEBHOOK_URL in production when `alertOnExhaustion` is true.
 */
export function attachWorkerFailureHandler(
  worker: Worker,
  options: WorkerFailureHandlerOptions,
): void {
  const { queueName, alertOnExhaustion = true } = options;
  const isProd = process.env.NODE_ENV === 'production';

  worker.on('failed', (job: Job | undefined, err: Error) => {
    if (!isPermanentlyFailed(job)) {
      console.warn(`[jobs] ${queueName} job failed (will retry)`, {
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        attempts: job?.opts?.attempts,
        error: err.message,
      });
      return;
    }

    console.error(`[jobs] ${queueName} job permanently failed`, {
      jobId: job?.id,
      name: job?.name,
      error: err.message,
      stack: err.stack,
    });

    if (!alertOnExhaustion) return;

    if (!isProd) {
      console.info('[jobs] Dev mode: skipping external alert webhook');
      return;
    }

    void sendProductionAlert({
      queueName,
      jobId: job?.id?.toString(),
      jobName: job?.name,
      message: err.message,
      stack: err.stack,
    });
  });
}
