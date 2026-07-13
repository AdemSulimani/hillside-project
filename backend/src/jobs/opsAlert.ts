/**
 * P1-2: the operator-facing "a queue job died" alert (Slack/Discord-style webhook POST).
 *
 * Extracted so both paths share one formatter/transport:
 *  - failureHandler's legacy inline path (when DLQ exhaustion alerts are disabled), and
 *  - the revived `notifications` queue processor (`ops.jobFailed`), which delivers it with BullMQ's
 *    durable retry instead of a fire-and-forget axios call.
 *
 * Reuses the same ALERT_WEBHOOK_URL + `{ text }` shape as failureHandler and redisMemoryMonitor so
 * every ops alert lands in the same channel.
 */
import axios from 'axios';

export interface OpsJobFailedAlert {
  queueName: string;
  jobId?: string | null;
  jobName?: string | null;
  classification?: string | null;
  message: string;
  stack?: string | null;
}

export async function postOpsJobFailedAlert(payload: OpsJobFailedAlert): Promise<void> {
  const url = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!url) {
    console.warn('[jobs] ALERT_WEBHOOK_URL is not set; cannot send job-failure alert');
    return;
  }

  const text = [
    `🔴 *Queue job dead-lettered*`,
    `Queue: \`${payload.queueName}\``,
    `Job: \`${payload.jobName ?? 'unknown'}\` (\`${payload.jobId ?? 'unknown'}\`)`,
    payload.classification ? `Classification: \`${payload.classification}\`` : '',
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
      console.error('[jobs] Job-failure alert webhook returned non-success status', {
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
