/**
 * P1-2 (RC-20/21/18): BullMQ worker failure handling — classification, dead-lettering, and
 * exhaustion alerting.
 *
 * Attached to every worker (workers.ts). On `worker.on('failed')` it classifies the failure
 * (transient / terminal / stalled) and, when the verdict says so, writes a durable `dead_letter`
 * row and surfaces the silence: a Sentry event, a tenant-facing `ai_alerts` row for a dead `ai.reply`
 * job, and an operator notification via the (now revived) `notifications` queue.
 *
 * This file is the IO wiring; the pure decision/dispatch core is `orchestrateFailedJob`
 * (failedJobOrchestration.ts), unit-testable without a live queue/DB.
 *
 * The whole feature is behind default-off flags, so with flags unset this behaves exactly as before
 * (console.warn on a retryable failure; console.error + optional webhook on exhaustion).
 */
import type { Job, Worker } from 'bullmq';
import * as Sentry from '@sentry/node';
import { classifyJobFailure, type JobFailureClassification } from './failureClassifier';
import {
  orchestrateFailedJob,
  type FailedJobInfo,
  type FailedJobEffects,
  type FailedJobFlags,
} from './failedJobOrchestration';
import { insertDeadLetter } from '../db/models/deadLetter';
import { createAIAlert } from '../db/models/aiAlert';
import { findChannelById, type ChannelType } from '../db/models/channel';
import { socketService } from '../services/socketService';
import { notificationsQueue } from './queues/notificationsQueue';
import { postOpsJobFailedAlert } from './opsAlert';

/** `(process.env.X ?? 'false').trim().toLowerCase() === 'true'` — the repo's inline-flag idiom. */
function flag(name: string): boolean {
  return (process.env[name] ?? 'false').trim().toLowerCase() === 'true';
}

export interface WorkerFailureHandlerOptions {
  /** Logical queue name for logs, dead_letter rows, and alerts. */
  queueName: string;
  /** When false, exhausted failures are only logged (no external alert). */
  alertOnExhaustion?: boolean;
}

interface AiReplyJobDataShape {
  tenantId?: string;
  channelId?: string;
  conversationId?: string;
  traceId?: string;
}

function maxAttemptsForJob(job: Job): number {
  const n = job.opts.attempts;
  return typeof n === 'number' && n >= 1 ? n : 1;
}

/**
 * Surface a dead-lettered job to humans: Sentry always; for a dead `ai.reply` also a tenant-facing
 * alert + socket push; and an operator notification for any queue. Each step is independently
 * guarded so one failing channel never blocks the others.
 */
async function raiseExhaustionAlerts(
  info: FailedJobInfo,
  err: Error,
  classification: JobFailureClassification,
): Promise<void> {
  const data = info.data as AiReplyJobDataShape;
  const tenantId = data.tenantId ?? null;
  const conversationId = data.conversationId ?? null;
  const traceId = data.traceId ?? null;

  // Sentry — the first captureException in the codebase; a no-op when SENTRY_DSN is unset.
  try {
    Sentry.captureException(err, {
      tags: { queue: info.queueName, jobName: info.jobName ?? 'unknown', classification },
    });
  } catch (sentryErr) {
    console.error('[jobs] Sentry captureException failed', { err: sentryErr });
  }

  // Tenant-facing alert for a dead AI reply — the customer got no reply; the merchant must see it.
  if (info.queueName === 'ai' && info.jobName === 'ai.reply' && tenantId) {
    try {
      const alert = await createAIAlert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        message_id: null,
        reason: 'ai_reply_undelivered',
        details: {
          jobId: info.jobId,
          classification,
          attempts: info.attemptsMade,
          error: err.message.slice(0, 500),
          traceId,
        },
      });

      // Real-time push so an open inbox surfaces it immediately (best-effort, needs the channel).
      let channelType: ChannelType = 'facebook';
      let channelName = '—';
      if (data.channelId) {
        const channel = await findChannelById(data.channelId, tenantId);
        if (channel) {
          channelType = channel.type;
          channelName = channel.name;
        }
      }
      socketService.emitAIAlert(tenantId, {
        ...alert,
        message_content: null,
        contact_name: 'System',
        channel_type: channelType,
        channel_name: channelName,
      });
    } catch (alertErr) {
      console.error('[jobs] ai_reply_undelivered alert failed', { conversationId, tenantId, err: alertErr });
    }
  }

  // Operator notification via the revived notifications queue (durable retry). Guard against a
  // notifications job that itself dies → do not enqueue another notifications job (infinite loop).
  if (info.queueName !== 'notifications') {
    try {
      await notificationsQueue.add('ops.jobFailed', {
        queue: info.queueName,
        jobId: info.jobId,
        jobName: info.jobName,
        classification,
        tenantId,
        error: err.message.slice(0, 500),
        stack: err.stack ? err.stack.slice(0, 3500) : null,
      });
    } catch (enqueueErr) {
      console.error('[jobs] failed to enqueue ops.jobFailed notification', { err: enqueueErr });
    }
  }
}

const realEffects: FailedJobEffects = {
  insertDeadLetter: (input) => insertDeadLetter(input),
  raiseAlerts: raiseExhaustionAlerts,
};

/**
 * Fires on every failed attempt. Classifies the failure; on a will-retry verdict it only logs; on a
 * dead-letter verdict it records the job and (when enabled) raises alerts exactly once.
 */
export function attachWorkerFailureHandler(
  worker: Worker,
  options: WorkerFailureHandlerOptions,
): void {
  const { queueName, alertOnExhaustion = true } = options;
  const isProd = process.env.NODE_ENV === 'production';
  const flags: FailedJobFlags = {
    dlqEnabled: flag('DLQ_ENABLED'),
    alertsEnabled: flag('DLQ_EXHAUSTION_ALERTS_ENABLED'),
  };

  worker.on('failed', (job: Job | undefined, err: Error) => {
    if (!job) {
      console.error(`[jobs] ${queueName} job failed with no job handle`, { error: err.message });
      return;
    }

    const info: FailedJobInfo = {
      queueName,
      jobId: job.id != null ? String(job.id) : null,
      jobName: job.name ?? null,
      data: (job.data ?? {}) as Record<string, unknown>,
      failedReason: job.failedReason ?? null,
      attemptsMade: job.attemptsMade ?? 0,
      maxAttempts: maxAttemptsForJob(job),
    };

    const verdict = classifyJobFailure({
      failedReason: info.failedReason,
      errorName: err.name,
      errorMessage: err.message,
      attemptsMade: info.attemptsMade,
      maxAttempts: info.maxAttempts,
    });

    if (!verdict.deadLetter) {
      console.warn(`[jobs] ${queueName} job failed (will retry)`, {
        jobId: info.jobId,
        name: info.jobName,
        classification: verdict.classification,
        attemptsMade: info.attemptsMade,
        attempts: info.maxAttempts,
        error: err.message,
      });
      return;
    }

    console.error(`[jobs] ${queueName} job dead-lettered`, {
      jobId: info.jobId,
      name: info.jobName,
      classification: verdict.classification,
      attemptsMade: info.attemptsMade,
      attempts: info.maxAttempts,
      error: err.message,
      stack: err.stack,
    });

    // All DB / Sentry / enqueue work is async + best-effort: a failure here must never crash the
    // worker (mirrors the previous `void sendProductionAlert`).
    void orchestrateFailedJob(info, err, realEffects, flags).catch((orchErr) => {
      console.error('[jobs] failed-job orchestration error', { queueName, jobId: info.jobId, err: orchErr });
    });

    // Legacy inline operator webhook — kept only when the notifications-queue path is NOT taking over.
    if (!flags.alertsEnabled) {
      if (!alertOnExhaustion) return;
      if (!isProd) {
        console.info('[jobs] Dev mode: skipping external alert webhook');
        return;
      }
      void postOpsJobFailedAlert({
        queueName,
        jobId: info.jobId ?? undefined,
        jobName: info.jobName ?? undefined,
        classification: verdict.classification,
        message: err.message,
        stack: err.stack,
      });
    }
  });
}
